// Emotes - cache, lookup, processing, picker, block/inventory

// Multichat picker provider toggles \u2014 three filter chips that only show
// when the user focuses the search input. Local matches are always
// included; the chips control which provider APIs contribute.
const mcPickerSources = (() => {
  try {
    const raw = localStorage.getItem('hs-mc-picker-sources')
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.length) {
        // Migrate old 'here' entries \u2014 local matches are now implicit.
        return new Set(arr.filter((s) => s !== 'here'))
      }
    }
  } catch (_) {}
  return new Set(['7tv', 'ffz', 'hs'])
})()
function mcSaveSources() {
  try {
    localStorage.setItem('hs-mc-picker-sources', JSON.stringify([...mcPickerSources]))
  } catch (_) {}
}
// Remote search providers, in one place so the fetch/render loops can't drift.
// 'hs' is the native HeatSync emote directory (heatsync.org/api/emote-search).
// No 'bttv': their shared-search API went auth-only (403, 2026-08). Cached
// endpoints still serve already-added bttv emotes; there's just no search.
const MC_REMOTE_SOURCES = ['7tv', 'ffz', 'hs']
function mcHasExternalSource() {
  return MC_REMOTE_SOURCES.some((s) => mcPickerSources.has(s))
}

// Which third-party provider (7tv/bttv/ffz) wins a same-name collision within
// a tier (channel or global). Bridged to the settings registry
// (emoteProviderPriority, default '7tv' — matches the pre-existing hardcoded
// winner) via _RUNTIME_BRIDGE in main.js. Read live by _buildChannelEmoteCache
// and the global-emotes loader in loadEmotes() below.
let emoteProviderPriority = '7tv'

// Per-provider result caches keyed per-query. AbortController cancels stale
// in-flight requests on each keystroke. Results ACCUMULATE across pages
// (load-more appends), so a buried emote past the first page is reachable.
const mcProviderResults = { '7tv': [], bttv: [], ffz: [], hs: [] }
const mcProviderLastQuery = { '7tv': '', bttv: '', ffz: '', hs: '' }
const mcProviderInFlight = { '7tv': false, bttv: false, ffz: false, hs: false }
const mcProviderPage = { '7tv': 0, bttv: 0, ffz: 0, hs: 0 } // pages loaded so far (0 = none)
const mcProviderExhausted = { '7tv': false, bttv: false, ffz: false, hs: false }
const mcProviderSeenIds = { '7tv': new Set(), bttv: new Set(), ffz: new Set(), hs: new Set() }
// A page shorter than the provider's page size means we hit the tail. 'hs' is
// single-page (the endpoint returns top-100 by popularity, no pagination).
const MC_PAGE_SIZE = { '7tv': 60, bttv: 100, ffz: 200, hs: 100 }
const _mcProviderAborts = { '7tv': null, bttv: null, ffz: null, hs: null }
let mcCurrentQuery = ''
// Exact-match filter — when on, picker search shows only emotes whose name
// equals the query (drops prefix + substring), so a common stem like "xd"
// pins to the literal name. Client-side filter; no refetch needed to toggle.
let mcExactMatch = (() => {
  try {
    return localStorage.getItem('hs-mc-picker-exact') === '1'
  } catch (_) {
    return false
  }
})()
function mcSaveExact() {
  try {
    localStorage.setItem('hs-mc-picker-exact', mcExactMatch ? '1' : '0')
  } catch (_) {}
}
// Map<name, {url, provider, id}> — populated by rerenderSearch with remote
// provider results so the click handler can fire add-to-inventory before
// pasting. Bounded by # of unique provider-search names per session.
const mcRemoteEmoteIndex = new Map()

// Module-scope re-render so the async event listener can drive it.
let _mcSearchRenderedQuery = ''
function mcRerenderSearch(query) {
  const grid = document.getElementById('hs-mc-emote-grid')
  if (!grid) return
  mcRemoteEmoteIndex.clear()
  if (!query) {
    _mcSearchRenderedQuery = ''
    const allMap = new Map()
    for (const [k, v] of viewerPersonalEmotes) allMap.set(k, v)
    for (const cc of activeTabEmotePools()) for (const [k, v] of cc) if (!allMap.has(k)) allMap.set(k, v)
    for (const [k, v] of emoteCache) if (!allMap.has(k)) allMap.set(k, v)
    grid.innerHTML = renderEmoteSections(groupEmotes(allMap))
    attachChunkObserver(grid)
    markPickerDirty()
    return
  }
  // Best-match ordering — type a name, the exact match leads instantly, then
  // prefix, then substring; remote provider-fuzzy hits land last. Within a
  // match bucket: owned > channel > global-local > remote (locality), then
  // popularity (provider order / local iteration order = `pop`), then alpha.
  // `pop` is a monotonic insertion counter, so already-shown tiles keep a
  // stable order when load-more appends new pages.
  const seenNames = new Set()
  const entries = []
  let pop = 0
  const matchQuality = (nl) => (nl === query ? 0 : nl.startsWith(query) ? 1 : nl.includes(query) ? 2 : 3)
  // Local matches (your set + channel + globals) — locality 0/1/2.
  {
    const localLoc = new Map()
    const pool = new Map()
    for (const [k, v] of viewerPersonalEmotes) {
      pool.set(k, v)
      localLoc.set(k, 0)
    }
    for (const sc of activeTabEmotePools())
      for (const [k, v] of sc)
        if (!pool.has(k)) {
          pool.set(k, v)
          localLoc.set(k, 1)
        }
    for (const [k, v] of emoteCache)
      if (!pool.has(k)) {
        pool.set(k, v)
        localLoc.set(k, 2)
      }
    for (const [name, emote] of pool) {
      const mq = matchQuality(name.toLowerCase())
      if (mq === 3) continue // local has no fuzzy concept — substring or nothing
      if (mcExactMatch && mq !== 0) continue
      seenNames.add(name)
      entries.push({ name, emote, mq, loc: localLoc.get(name) ?? 2, pop: pop++ })
    }
  }
  // Remote provider results — locality 3 (below all local). Provider order
  // already reflects popularity (7TV TOP_ALL_TIME / FFZ count-desc), preserved
  // via `pop`. Same-name dups collapse to the first (one tile per name —
  // inventory is name-keyed, so a viewer can only hold one image per name) —
  // iterate in emoteProviderPriority order so the collapse picks the same
  // winner as the merged channel/global pools ('hs' stays last, unaffected).
  for (const p of [...emoteProviderOrder(emoteProviderPriority), 'hs']) {
    if (!mcPickerSources.has(p)) continue
    if (mcProviderLastQuery[p] !== query) continue
    for (const r of mcProviderResults[p]) {
      if (!r.name || seenNames.has(r.name)) continue
      const mq = matchQuality(r.name.toLowerCase())
      if (mcExactMatch && mq !== 0) continue
      seenNames.add(r.name)
      // state='remote' — unowned picker result, click handler routes through
      // addEmoteToInventory to persist. Auto-add-on-send also commits the slot.
      entries.push({
        name: r.name,
        // source tracks the emote's real provider (r.provider), which equals the
        // bucket key p for third-party but is 'heatsync' for the 'hs' directory —
        // keeps source/provider aligned for state + tooltip + re-add.
        emote: { source: r.provider || p, state: 'remote', url: r.url, provider: r.provider },
        mq,
        loc: 3,
        pop: pop++,
      })
      mcRemoteEmoteIndex.set(r.name, { url: r.url, provider: r.provider, id: r.id, zeroWidth: !!r.zeroWidth })
    }
  }
  entries.sort((a, b) => a.mq - b.mq || a.loc - b.loc || a.pop - b.pop || a.name.localeCompare(b.name))
  // One unified flat feed — no section headers, no visual distinction between
  // owned and remote results. Click handler routes remote emotes through
  // add-to-inventory transparently.
  const flatEntries = entries.map((e) => [e.name, e.emote])
  const flatSection = [{ key: 'search', label: '', emotes: flatEntries }]
  // Preserve scroll position only when re-rendering the SAME query (load-more
  // appends below the fold — don't snap to top). A new query resets to top.
  const sameQuery = query === _mcSearchRenderedQuery
  const prevScroll = grid.scrollTop
  _mcSearchRenderedQuery = query
  grid.innerHTML = renderEmoteSections(flatSection, t('common_no_matches'), { noHeaders: true })
  // `[ load more ]` tile while any enabled provider still has pages to fetch.
  // Suppressed in exact mode: deeper pages only yield more same-name dups that
  // collapse to the tiles already shown, so paging would just burn round-trips
  // on results the exact filter discards.
  const canLoadMore =
    entries.length > 0 &&
    !mcExactMatch &&
    MC_REMOTE_SOURCES.some((p) => mcPickerSources.has(p) && !mcProviderExhausted[p])
  if (canLoadMore) {
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'hs-mc-load-more'
    more.textContent = t('mc_emote_load_more')
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      more.textContent = t('common_loading') // reset on the next results-ready rebuild
      more.disabled = true
      mcLoadMoreSearch()
    })
    grid.appendChild(more)
  }
  grid.scrollTop = sameQuery ? prevScroll : 0
  attachChunkObserver(grid)
  markPickerDirty()
}

// 7TV v4 GraphQL \u2014 TOP_ALL_TIME popularity. perPage 60 for the picker
// (mcTriggerProviderSearches); Tab-complete passes a smaller perPage for
// prefix-only quality.
const MC_SEVEN_TV_V4_GQL = `query SearchEmotes($query: String!, $page: Int!, $perPage: Int!) {
    emotes {
      search(query: $query, sort: { sortBy: TOP_ALL_TIME, order: DESCENDING }, page: $page, perPage: $perPage) {
        totalCount
        items { id defaultName flags { animated defaultZeroWidth } }
      }
    }
  }`

async function mcSearch7tvApi(q, signal, opts) {
  const perPage = opts && Number.isFinite(opts.perPage) ? opts.perPage : 60
  const page = opts && Number.isFinite(opts.page) ? opts.page : 1
  const resp = await fetch('https://api.7tv.app/v4/gql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      operationName: 'SearchEmotes',
      query: MC_SEVEN_TV_V4_GQL,
      variables: { query: q, page, perPage },
    }),
  })
  if (!resp.ok) throw new Error(`7tv ${resp.status}`)
  const data = await resp.json()
  const items = data?.data?.emotes?.search?.items || []
  return items.map((e) => ({
    name: e.defaultName,
    url: `https://cdn.7tv.app/emote/${e.id}/1x.avif`,
    provider: '7tv',
    id: e.id,
    animated: !!e.flags?.animated,
    zeroWidth: !!e.flags?.defaultZeroWidth,
  }))
}

async function mcSearchFfzApi(q, signal, opts) {
  const page = opts && Number.isFinite(opts.page) ? opts.page : 1
  const r = await fetch(
    `https://api.frankerfacez.com/v1/emotes?q=${encodeURIComponent(q)}&sort=count-desc&per_page=${MC_PAGE_SIZE.ffz}&page=${page}`,
    { signal },
  )
  if (!r.ok) throw new Error(`ffz ${r.status}`)
  const data = await r.json()
  const items = Array.isArray(data?.emoticons) ? data.emoticons : []
  return items.map((e) => {
    // FFZ animated emotes live under e.animated (animated webp); e.urls is the
    // static PNG first-frame. Prefer animated so added/picked emotes don't freeze.
    const u = e.animated || e.urls || {}
    return {
      name: e.name,
      url: u['1'] || u['2'] || u['4'] || '',
      provider: 'ffz',
      id: String(e.id),
      animated: !!e.animated,
      uses: Number(e.usage_count || 0),
    }
  })
}

// Native HeatSync emote directory. Unlike the third-party providers this hits
// heatsync.org's own search endpoint (moderation-gated: native uploads only,
// provably-scanned, popularity-ranked). Single-page by design — the endpoint
// returns the top ~100 in one shot, so page>1 resolves empty and trips the
// exhausted flag, killing load-more cleanly (no infinite same-page refetch).
async function mcSearchHsApi(q, signal, opts) {
  const page = opts && Number.isFinite(opts.page) ? opts.page : 1
  if (page > 1) return [] // no server-side pagination — tail after page 1
  const r = await fetch(`https://heatsync.org/api/emote-search?q=${encodeURIComponent(q)}&p=hs`, {
    signal,
    credentials: 'omit',
  })
  if (!r.ok) throw new Error(`hs ${r.status}`)
  const data = await r.json()
  const items = (data?.results && Array.isArray(data.results.hs) && data.results.hs) || []
  return items.map((e) => ({
    name: e.name,
    url: e.url, // already an absolute cdn.heatsync.org url
    // 'heatsync' is the ext's canonical source name (detectEmoteSource,
    // getEmoteState, .src-heatsync) — the 'hs' key is only the search wire
    // protocol (chip + endpoint param), so the rendered emote stays consistent.
    provider: 'heatsync',
    id: e.id,
    animated: !!e.animated,
  }))
}

// Provider → page-fetcher. Add a provider here + to MC_REMOTE_SOURCES and every
// loop below picks it up — no scattered ternaries to update.
const MC_PROVIDER_FETCHERS = {
  '7tv': mcSearch7tvApi,
  ffz: mcSearchFfzApi,
  hs: mcSearchHsApi,
}

function mcResetProvider(p) {
  mcProviderResults[p] = []
  mcProviderSeenIds[p].clear()
  mcProviderPage[p] = 0
  mcProviderExhausted[p] = false
  mcProviderInFlight[p] = false
  mcProviderLastQuery[p] = ''
}

// Fetch the next page for one provider and APPEND (dedup by id) to its
// accumulated results. Guarded so it's a no-op while a fetch is in flight or
// the provider is exhausted, so a load-more burst or rapid clicks can't pile
// up duplicate requests.
function mcFetchProviderPage(p, q) {
  if (!q || !mcPickerSources.has(p) || mcProviderExhausted[p] || mcProviderInFlight[p]) return
  const page = mcProviderPage[p] + 1
  const ac = new AbortController()
  _mcProviderAborts[p] = ac
  mcProviderInFlight[p] = true
  const fn = MC_PROVIDER_FETCHERS[p]
  if (!fn) {
    mcProviderInFlight[p] = false
    return
  }
  fn(q, ac.signal, { page })
    .then((items) => {
      if (ac.signal.aborted || mcCurrentQuery !== q) return
      mcProviderInFlight[p] = false
      mcProviderPage[p] = page
      mcProviderLastQuery[p] = q
      // A short page means the tail — stop offering more for this provider.
      if (!Array.isArray(items) || items.length < MC_PAGE_SIZE[p]) mcProviderExhausted[p] = true
      const seen = mcProviderSeenIds[p]
      for (const it of items || []) {
        const key = it.id || it.name
        if (key && seen.has(key)) continue
        if (key) seen.add(key)
        mcProviderResults[p].push(it)
      }
      document.dispatchEvent(new CustomEvent('hs-mc-search-results-ready', { detail: { query: q, provider: p } }))
    })
    .catch((err) => {
      if (ac.signal.aborted || err?.name === 'AbortError') return
      mcProviderInFlight[p] = false
      // Stop hammering a failing provider, but keep pages already fetched.
      mcProviderExhausted[p] = true
      document.dispatchEvent(new CustomEvent('hs-mc-search-results-ready', { detail: { query: q, provider: p } }))
    })
}

// Initial search for a new query — reset pagination per provider (aborting any
// stale in-flight page) and fetch page 1. A provider already holding results
// for this exact query is a cache hit (skipped), so re-toggling a chip or
// re-opening the picker doesn't refetch.
function mcTriggerProviderSearches(q) {
  for (const p of MC_REMOTE_SOURCES) {
    if (!q) {
      if (_mcProviderAborts[p]) {
        try {
          _mcProviderAborts[p].abort()
        } catch (_) {}
      }
      mcResetProvider(p)
      continue
    }
    if (!mcPickerSources.has(p)) {
      // Just-disabled provider — abort any in-flight page so it can't push a
      // stale result + fire a spurious repaint. Clear inFlight here: the
      // aborted fetch's .then/.catch bail early without resetting it, so
      // without this a later re-enable would leave the guard stuck and
      // load-more silently dead for the rest of the query.
      if (_mcProviderAborts[p]) {
        try {
          _mcProviderAborts[p].abort()
        } catch (_) {}
      }
      mcProviderInFlight[p] = false
      continue
    }
    // Cache hit: same query already resolved (results, or definitively exhausted
    // with zero results — don't refetch a known-empty provider on every toggle).
    if (mcProviderLastQuery[p] === q && (mcProviderResults[p].length > 0 || mcProviderExhausted[p])) continue
    if (_mcProviderAborts[p]) {
      try {
        _mcProviderAborts[p].abort() // kill a stale page (e.g. "xd" page 2) before the new query
      } catch (_) {}
    }
    mcResetProvider(p)
    mcFetchProviderPage(p, q)
  }
}

// Load-more — pull the next page from every enabled, non-exhausted provider.
function mcLoadMoreSearch() {
  const q = mcCurrentQuery
  if (!q) return
  for (const p of MC_REMOTE_SOURCES) mcFetchProviderPage(p, q)
}

const UNICODE_EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+$/u
const WS_RE = /^\s+$/
const LINK_RE = /^(https?:\/\/\S+|[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*)/i

// Emote size (1, 2, or 4)
let emoteSize = 1

// Animate-emotes mode (registry: animateEmotes): 'always' | 'hover' | 'never'.
// hover and never both RENDER static srcs — hover swaps a row's emotes to
// data-emote-url while the pointer is on it (listener in main.js). Static
// srcs are each CDN's native static variant (zero server load); only URLs
// with no known static form route through heatsync's emote proxy with
// static=1 (server extracts the first frame, 30-day immutable cache).
// data-emote-url keeps the ORIGINAL url for tooltips/copy/re-add.
let emoteAnimationMode = 'always'
// Mode-independent half of staticEmoteSrc below — the offscreen idle gate
// needs the static variant of a URL even while emoteAnimationMode is
// 'always' (that's the one mode staticEmoteSrc itself short-circuits on).
// The one static-url deriver; nothing else computes a static variant.
function deriveStaticEmoteSrc(url) {
  if (!url) return url
  if (url.indexOf('/api/emote-proxy') !== -1) return url
  // 7TV: Nx.{avif,webp,gif} → Nx_static.{avif,webp,gif} (covers avif, which
  // the old gif/webp-only regex missed on Chrome)
  if (url.includes('cdn.7tv.app')) return url.replace(/\/(\dx)\.(avif|webp|gif)(\?|$)/i, '/$1_static.$2$3')
  // Twitch native: /default/ format token → /static/ (extensionless URLs;
  // identical image for non-animated emotes, so no animated-detection needed)
  if (url.includes('static-cdn.jtvnw.net/emoticons/')) return url.replace('/default/', '/static/')
  // BTTV: /emote/{id}/{size} → /emote/{id}/static/{size}
  if (url.includes('cdn.betterttv.net/emote/')) return url.replace(/(\/emote\/[a-f0-9]+)\//i, '$1/static/')
  // Kick: extensionless /fullsize URLs have no CDN static variant — proxy
  // them (files.kick.com is allowlisted server-side; static pngs pass through)
  if (/files\.kick\.com\/emotes\//i.test(url))
    return `https://heatsync.org/api/emote-proxy?url=${encodeURIComponent(url)}&static=1`
  if (!/\.(gif|webp)(\?|$)/i.test(url)) return url
  return `https://heatsync.org/api/emote-proxy?url=${encodeURIComponent(url)}&static=1`
}
function staticEmoteSrc(url) {
  if (emoteAnimationMode === 'always' || !url) return url
  return deriveStaticEmoteSrc(url)
}

// ── offscreen idle gate (animateEmotes: 'always') ───────────────────────────
// 'hover'/'never' already render static srcs (see staticEmoteSrc above) — the
// only mode with a real cost is 'always', where every row's animated
// webp/avif keeps its own decoder running for as long as the img stays in
// the DOM. At DOM_RENDER_CAP=500 a busy channel means ~470 offscreen rows
// decoding animation forever. Same tax paints.js's viewport gate exists for
// (see its "viewport gate" section) — a CSS animation can be paused, a
// decoded raster image can't, so the only lever is swapping the img away
// from the animated url while it's off-screen and swapping it back with
// enough runway (rootMargin) that a scroll never uncovers a frozen frame.
//
// Reuses the render path's own primitives instead of forking a second
// static-url deriver or a second stash convention: data-emote-url on the
// wrapper (set at render time, see hsPaintRender-style templates above) is
// already the stable ORIGINAL animated url, so there is nothing to stash —
// restoring is just writing that same url back.
const hsIdleEmoteRows = new Set()
let hsIdleEmoteObserver = null
let hsIdleEmoteSweepScheduled = false
let hsIdleEmoteSweepForced = false
let hsIdleEmoteLastDiscoverAt = 0
const HS_EMOTE_IDLE_DISCOVER_MIN_MS = 250

/** Swap (or restore) every animated emote img in one row. Class/src writes
 * only — no layout read, so this is safe to call straight from an IO
 * callback without fighting the chat pane's scroll-pin. */
function hsSwapRowEmotesForIdle(row, idle) {
  for (const img of row.querySelectorAll('img.hs-mc-emote')) {
    const orig = img.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl
    if (!orig) continue
    if (idle) {
      // Only swap a row still showing the true original — a static/avif
      // fallback already in place (hsStaticFell/hsAvifFell) or a prior idle
      // swap must not be clobbered.
      if (img.src !== orig) continue
      const staticSrc = deriveStaticEmoteSrc(orig)
      if (staticSrc === orig) continue // no static variant for this CDN/url
      img.src = staticSrc
    } else if (img.src !== orig) {
      img.src = orig
    }
  }
}

function ensureHsEmoteIdleObserver() {
  if (hsIdleEmoteObserver || typeof IntersectionObserver !== 'function') return hsIdleEmoteObserver
  // No root, same reasoning as paints.js's viewport gate: this module
  // doesn't know which pane a row lives in. The margin keeps a screen of
  // rows warm either side so a scroll never uncovers a frozen frame.
  hsIdleEmoteObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) hsSwapRowEmotesForIdle(entry.target, !entry.isIntersecting)
    },
    { rootMargin: '150% 0px' },
  )
  return hsIdleEmoteObserver
}

/** Drop targets that left the DOM — an IntersectionObserver holds its
 * targets strongly, and the hidden-tab shed + normal trim-to-cap both remove
 * rows continuously. Bounded by the observed count, no DOM query. */
function reapHsIdleEmoteRows(io) {
  for (const row of hsIdleEmoteRows) {
    if (!row.isConnected) {
      io.unobserve(row)
      hsIdleEmoteRows.delete(row)
    }
  }
}

/** Find rows we aren't watching yet. Rows are appended at several call
 * sites (initial render, live append, history restore) with no single
 * construction hook, so — same call as paints.js's discovery — a bounded
 * document query is what actually covers every one of them. */
function discoverHsIdleEmoteRows(io) {
  hsIdleEmoteLastDiscoverAt = Date.now()
  for (const row of document.querySelectorAll('.hs-mc-msg')) {
    if (hsIdleEmoteRows.has(row)) continue
    hsIdleEmoteRows.add(row)
    io.observe(row)
  }
}

function sweepHsEmoteIdleRows(force) {
  if (emoteAnimationMode !== 'always') return
  const io = ensureHsEmoteIdleObserver()
  if (!io) return
  reapHsIdleEmoteRows(io)
  if (force || Date.now() - hsIdleEmoteLastDiscoverAt >= HS_EMOTE_IDLE_DISCOVER_MIN_MS) discoverHsIdleEmoteRows(io)
}

/** One sweep per frame — see paints.js's identical scheduler for why. */
function scheduleHsEmoteIdleSweep(force) {
  if (force) hsIdleEmoteSweepForced = true
  if (hsIdleEmoteSweepScheduled || typeof requestAnimationFrame !== 'function') return
  hsIdleEmoteSweepScheduled = true
  requestAnimationFrame(() => {
    hsIdleEmoteSweepScheduled = false
    const f = hsIdleEmoteSweepForced
    hsIdleEmoteSweepForced = false
    sweepHsEmoteIdleRows(f)
  })
}

/** A settings change out of 'always' must stop cleanly: unswap every row
 * still mid-gate, disconnect, and forget them — main.js's emoteAnimation
 * applier calls this before its full re-render replaces the rows anyway,
 * but a row this exact tick hasn't been rebuilt yet must not linger frozen
 * on its static src. Switching back into 'always' just lets the next
 * scroll/pin re-arm the observer from scratch (ensureHsEmoteIdleObserver). */
function teardownHsEmoteIdleGate() {
  if (hsIdleEmoteObserver) {
    for (const row of hsIdleEmoteRows) hsSwapRowEmotesForIdle(row, false)
    hsIdleEmoteObserver.disconnect()
  }
  hsIdleEmoteObserver = null
  hsIdleEmoteRows.clear()
}

// Scroll is when visibility changes, and also when a pane autoscrolls a new
// message in (scheduleScrollPin's scrollTop write fires it too). Capture so
// it hears every pane, passive so it never delays one. Reaping is cheap (no
// query) and runs every sweep; discovery is bounded above. sweepHsEmoteIdleRows
// itself no-ops outside 'always' mode, so this listener costs one flag check
// per scroll frame in 'hover'/'never'.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('scroll', () => scheduleHsEmoteIdleSweep(false), { capture: true, passive: true })
}

// Upgrade emote URL to match current emote size setting.
// Memoized: input URLs are bounded by emote count (~few thousand). Cache
// resets when emoteSize changes — same input → same output otherwise.
// Firefox has no animated-AVIF decoder (Chrome-only). 7TV serves emotes as
// avif by default, so animated 7TV emotes render as a frozen first frame on
// Firefox. Detect once and rewrite 7TV avif → webp at the chat chokepoint
// below (FF animates webp fine; static webp is correct too, just marginally
// larger). Chrome keeps avif.
// NB: `typeof browser` is NOT a usable FF signal in this bundle — background's
// `const browser = globalThis.browser || chrome` alias makes it truthy on
// Chrome too, which (verified live) wrongly stripped avif on Chrome. The UA is
// the reliable discriminator: only Firefox's userAgent contains "Firefox".
const HS_IS_FF = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox')
let _resCacheSize = 1
const _resCache = new Map()
function getChatResUrl(url) {
  if (!url) return url
  if (_resCacheSize !== emoteSize) {
    _resCache.clear()
    _resCacheSize = emoteSize
  }
  const hit = _resCache.get(url)
  if (hit !== undefined) return hit
  let out = url
  if (emoteSize === 1) {
    // True native: downgrade Twitch native (IRC fetches at /2.0) and 3rd-party CDNs to 1x.
    if (url.includes('static-cdn.jtvnw.net')) out = url.replace(/\/[23]\.0/, '/1.0')
    else if (url.includes('cdn.7tv.app')) out = url.replace(/\/[234]x/, '/1x')
    else if (url.includes('cdn.betterttv.net')) out = url.replace(/\/[23]x/, '/1x')
    else if (url.includes('cdn.frankerfacez.com')) out = url.replace(/\/[24](?=\.|$)/, '/1')
  } else if (emoteSize === 2) {
    if (url.includes('cdn.7tv.app')) out = url.replace('/1x', '/2x')
    else if (url.includes('cdn.betterttv.net')) out = url.replace('/1x', '/2x')
    else if (url.includes('cdn.frankerfacez.com')) out = url.replace(/\/1(?=\.|$)/, '/2')
    else if (url.includes('static-cdn.jtvnw.net')) out = url.replace('/1.0', '/2.0')
  } else if (emoteSize === 4) {
    if (url.includes('cdn.7tv.app')) out = url.replace('/1x', '/4x').replace('/2x', '/4x')
    else if (url.includes('cdn.betterttv.net')) out = url.replace('/1x', '/3x').replace('/2x', '/3x')
    else if (url.includes('cdn.frankerfacez.com')) out = url.replace(/\/[12](?=\.|$)/, '/4')
    else if (url.includes('static-cdn.jtvnw.net')) out = url.replace(/\/[12]\.0/, '/3.0')
  }
  // Firefox: 7TV avif → webp (animated avif freezes on FF; see HS_IS_FF above).
  // Applied after the size rewrite so it isn't clobbered.
  if (HS_IS_FF && out.includes('cdn.7tv.app')) out = out.replace(/\.avif(\?|$)/i, '.webp$1')
  _resCache.set(url, out)
  if (_resCache.size > 2000) _resCache.delete(_resCache.keys().next().value)
  return out
}

// Upgrade emote URL to highest resolution for tooltip
function getHighResUrl(url) {
  if (!url) return url
  // 7TV: /1x → /4x
  if (url.includes('cdn.7tv.app')) {
    return url.replace('/1x', '/4x').replace('/2x', '/4x').replace('/3x', '/4x')
  }
  // BTTV: /1x → /3x (max)
  if (url.includes('cdn.betterttv.net')) {
    return url.replace('/1x', '/3x').replace('/2x', '/3x')
  }
  // FFZ: /1 → /4
  if (url.includes('cdn.frankerfacez.com')) {
    return url.replace(/\/1(?=\.|$)/, '/4').replace(/\/2(?=\.|$)/, '/4')
  }
  // Twitch: /1.0 → /3.0 (max)
  if (url.includes('static-cdn.jtvnw.net')) {
    return url.replace('/1.0', '/3.0').replace('/2.0', '/3.0')
  }
  return url
}

/**
 * Group emotes by state+source into ordered sections
 */
// 'set' = anything the user owns (state==='owned'), regardless of original
// provider. Without this branch a 7tv emote in the user's heatsync set
// would bucket into '7tv' and the user's 982-emote set would scatter
// across every section instead of sitting in one.
const SECTION_ORDER = ['set', '7tv', 'bttv', 'ffz', 'twitch', 'kick', 'heatsync']
const SECTION_LABELS = {
  set: 'inventory',
  '7tv': '7TV',
  bttv: 'BTTV',
  ffz: 'FFZ',
  twitch: 'Twitch',
  kick: 'Kick',
  heatsync: 'Heatsync',
}

// Recently-used emotes — a local MRU list (most-recent first), captured on
// every insert via the picker or tab-complete (see recordRecentEmote). There
// is no server-side personal usage signal in the picker (the `uses` field on
// search results is FFZ global popularity, not per-user), so this starts
// empty on a fresh device and fills as the user inserts emotes. Rendered as
// the first picker section; omitted entirely while empty (no dead header).
const RECENT_KEY = 'hs-mc-recent-emotes'
const RECENT_CAP = 24

function loadRecentEmotes() {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY))
    return Array.isArray(r) ? r : []
  } catch (_) {
    return []
  }
}

function recordRecentEmote(name) {
  if (!name) return
  let list = loadRecentEmotes().filter((n) => n !== name)
  list.unshift(name)
  if (list.length > RECENT_CAP) list = list.slice(0, RECENT_CAP)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch (_) {}
  bumpEmoteFrecency(name)
  // The cache key doesn't track the MRU list, so force a rebuild on next
  // open (idle prebuild repopulates before reopen → still instant).
  markPickerDirty()
}

// Frecency — per-emote use count with recency decay, feeding tab-complete
// ranking. The RECENT_KEY list above is recency-only and capped at 24, which
// made ordering fragile: one accidental completion of KKonaLand outranked
// KKona used a hundred times, and a habitual emote silently fell off the cap.
// Score = uses halved per week since last use, so an old habit fades but a
// single stray insert never beats a real one.
const FRECENCY_KEY = 'hs-mc-emote-frecency'
const FRECENCY_CAP = 200
const FRECENCY_HALF_LIFE_MS = 7 * 24 * 3600e3

function _loadFrecencyRaw() {
  try {
    const r = JSON.parse(localStorage.getItem(FRECENCY_KEY))
    if (r && typeof r === 'object' && !Array.isArray(r)) return r
  } catch (_) {}
  // First run: seed from the legacy MRU list so existing habits carry over
  // (staggered timestamps preserve the list's recency order).
  const seeded = {}
  const legacy = loadRecentEmotes()
  for (let i = 0; i < legacy.length; i++) {
    seeded[legacy[i]] = { n: 1, t: Date.now() - i * 3600e3 }
  }
  return seeded
}

function _frecencyScore(entry, now) {
  if (!entry || !(entry.n > 0)) return 0
  const age = Math.max(0, now - (entry.t || 0))
  return entry.n * 2 ** (-age / FRECENCY_HALF_LIFE_MS)
}

// findEmoteMatches calls loadEmoteFrecency() on every debounced keystroke —
// re-reading + JSON.parse'ing localStorage and rebuilding the decayed Map
// each time was pure waste when nothing changed since the last call. Cache
// the built Map, keyed off the raw localStorage string itself (a cheap
// getItem + === check) rather than a manual invalidation flag — self-heals
// against ANY write to the key, not just the two functions below.
let _frecencyCache = null // { raw, map }

/** name → decayed score (>0 means "the user has actually inserted this"). */
function loadEmoteFrecency() {
  let raw
  try {
    raw = localStorage.getItem(FRECENCY_KEY)
  } catch (_) {
    raw = null
  }
  if (_frecencyCache && _frecencyCache.raw === raw) return _frecencyCache.map
  const parsed = _loadFrecencyRaw()
  const now = Date.now()
  const out = new Map()
  for (const [name, entry] of Object.entries(parsed)) {
    const s = _frecencyScore(entry, now)
    if (s > 0) out.set(name, s)
  }
  _frecencyCache = { raw, map: out }
  return out
}

/** Revert one bump — used when the user cycles PAST a candidate mid-session,
 *  so only the emote they stop on keeps the credit. Subtracting 1 restores the
 *  exact pre-bump decayed score (bump set n = decayed + 1 at t = now). */
function unbumpEmoteFrecency(name) {
  if (!name) return
  const raw = _loadFrecencyRaw()
  const cur = raw[name]
  if (!cur) return
  const n = (cur.n || 0) - 1
  if (n <= 0) delete raw[name]
  else raw[name] = { n, t: cur.t }
  try {
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(raw))
  } catch (_) {}
}

function bumpEmoteFrecency(name) {
  if (!name) return
  const raw = _loadFrecencyRaw()
  const cur = raw[name]
  const now = Date.now()
  // Fold the decayed old score into the new count so frequency survives the
  // bump instead of resetting the decay clock on the full total.
  raw[name] = { n: _frecencyScore(cur, now) + 1, t: now }
  const names = Object.keys(raw)
  if (names.length > FRECENCY_CAP) {
    names.sort((a, b) => _frecencyScore(raw[a], now) - _frecencyScore(raw[b], now))
    for (const dead of names.slice(0, names.length - FRECENCY_CAP)) delete raw[dead]
  }
  try {
    localStorage.setItem(FRECENCY_KEY, JSON.stringify(raw))
  } catch (_) {}
}

// Resolve MRU names to live emote pairs, dropping any no longer available
// (blocked, removed, or not loaded for this channel). A recent emote also
// appears in its source section below — intended, mirrors Discord.
function buildRecentSection(allEmotes) {
  const out = []
  for (const name of loadRecentEmotes()) {
    const e = allEmotes.get(name)
    if (e) out.push([name, e])
    if (out.length >= RECENT_CAP) break
  }
  return out.length ? { key: 'recent', label: 'recent', emotes: out } : null
}

function groupEmotes(allEmotes) {
  const groups = {}
  for (const [name, emote] of allEmotes) {
    const key = emote.state === 'owned' ? 'set' : emote.source
    if (!groups[key]) groups[key] = []
    groups[key].push([name, emote])
  }
  const sections = SECTION_ORDER.filter((k) => groups[k]?.length).map((k) => ({
    key: k,
    label: SECTION_LABELS[k] || k,
    emotes: groups[k],
  }))
  const recent = buildRecentSection(allEmotes)
  if (recent) sections.unshift(recent)
  return sections
}

// Chunked lazy render: with 2k+ emotes, building all <img> up-front blocks
// the main thread for hundreds of ms. Split each section into chunks of
// CHUNK_SIZE; render placeholder divs with estimated min-heights so the
// scrollbar is correct, then populate each chunk via IntersectionObserver
// as it nears the viewport. All emote name/url/source strings remain
// escapeHtml'd inside emoteImgHtml() at populate time.
const CHUNK_SIZE = 96
// Per-bundle-eval token for the picker click re-attach guard (see the
// picker.addEventListener block) — unique every content-script context.
const _HS_PICKER_CLICK_CTX = `ctx_${Math.random().toString(36).slice(2)}`
const _chunkStore = new Map()
/**
 * One observer PER scroll root, not one globally.
 *
 * An IntersectionObserver bakes its `root` in at construction, and a target that
 * is not a descendant of that root is never reported as intersecting. The cache
 * used to be a single observer returned for any root, so whichever scope called
 * first won: attachChunkObserver runs with the search `grid` at two sites and
 * with the whole `picker` at a third, and if the grid got there first every
 * picker-level chunk was handed an observer rooted inside the grid and could
 * never fire. Nothing threw — the chunks simply stopped lazy-filling on scroll,
 * masked by renderVisibleChunks eagerly filling the first 16.
 */
const _chunkObservers = new Map()

function clearChunkStore() {
  _chunkStore.clear()
  for (const obs of _chunkObservers.values()) obs.disconnect()
  _chunkObservers.clear()
}

// Fill one chunk placeholder from its stored emote data. Returns true if filled.
function _fillChunk(el) {
  const key = el.dataset.chunkKey
  const data = _chunkStore.get(key)
  if (!data) return false
  el.innerHTML = data.map(emoteImgHtml).join('')
  el.style.minHeight = ''
  el.classList.add('hs-mc-chunk-ready')
  _chunkStore.delete(key)
  return true
}

function ensureChunkObserver(scrollRoot) {
  const cached = _chunkObservers.get(scrollRoot)
  if (cached) return cached
  const obs = new IntersectionObserver(
    // Second callback arg, not the outer binding: an observer should unobserve
    // through ITSELF, so this cannot drift if the cache shape changes again.
    (entries, self) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        _fillChunk(e.target)
        self.unobserve(e.target)
      }
    },
    { root: scrollRoot, rootMargin: '300px 0px', threshold: 0 },
  )
  _chunkObservers.set(scrollRoot, obs)
  cleanup.trackObserver(obs)
  return obs
}

// The IntersectionObserver never fires while the tab is hidden/occluded (a
// background OBS popout, an unfocused window), so a picker opened there stayed
// blank forever. Immediately fill every chunk already within the scroll
// viewport (+ lookahead) on open, so the picker is never empty regardless of IO
// timing or visibility; the observer still lazy-fills the rest on scroll. Capped
// so a not-yet-laid-out grid can't force a full synchronous render.
function renderVisibleChunks(scope) {
  const scrollRoot = scope.querySelector('.hs-mc-picker-scroll') || scope
  const vh = scrollRoot.clientHeight
  if (!vh) return // no layout yet — the observer covers it once shown
  const cutoff = (scrollRoot.scrollTop || 0) + vh + 400
  let filled = 0
  for (const el of scope.querySelectorAll('.hs-mc-picker-chunk:not(.hs-mc-chunk-ready)')) {
    if (el.offsetTop > cutoff) continue
    if (_fillChunk(el)) {
      _chunkObservers.get(scrollRoot)?.unobserve(el)
      if (++filled >= 16) break
    }
  }
}

function attachChunkObserver(scope) {
  const scrollRoot = scope.querySelector('.hs-mc-picker-scroll') || scope
  const obs = ensureChunkObserver(scrollRoot)
  scope.querySelectorAll('.hs-mc-picker-chunk:not(.hs-mc-chunk-ready)').forEach((el) => {
    obs.observe(el)
  })
  renderVisibleChunks(scope)
}

function estimateChunkHeight(count) {
  const perRow = 7
  const rowHeight = 36
  return Math.ceil(count / perRow) * rowHeight
}

function renderEmoteSections(sections, emptyMsg = t('mc_emote_no_loaded'), opts) {
  clearChunkStore()
  if (!sections.length) {
    // Cold-start: personal + channel + global caches are all empty. Not the
    // "no search matches" case (that passes opts.noHeaders + its own emptyMsg)
    // — point the user at the one-click channel import instead of a dead end.
    const channel = !opts?.noHeaders && getCurrentChannel()
    if (channel) return renderEmoteColdStart(channel)
    return `<div class="hs-mc-picker-empty">${escapeHtml(emptyMsg)}</div>`
  }
  const noHeaders = !!opts?.noHeaders
  return sections
    .map((s, si) => {
      const chunks = []
      for (let i = 0; i < s.emotes.length; i += CHUNK_SIZE) {
        chunks.push(s.emotes.slice(i, i + CHUNK_SIZE))
      }
      const chunksHtml = chunks
        .map((c, ci) => {
          const key = `${si}-${ci}`
          _chunkStore.set(key, c)
          const h = estimateChunkHeight(c.length)
          return (
            '<div class="hs-mc-picker-section-grid hs-mc-picker-chunk" data-chunk-key="' +
            key +
            '" style="min-height:' +
            h +
            'px"></div>'
          )
        })
        .join('')
      const header = noHeaders
        ? ''
        : `<div class="hs-mc-picker-section-header">${escapeHtml(s.label)} <span class="hs-mc-picker-section-count">${s.emotes.length}</span></div>`
      return `
      <div class="hs-mc-picker-section" data-section-key="${escapeHtml(s.key)}">
        ${header}
        ${chunksHtml}
      </div>`
    })
    .join('')
}

// Empty-inventory cold-start: point a fresh/logged-out-of-emotes user straight
// at the one-click channel import instead of a dead-end "no emotes" message.
// Mirrors chrome/heatsync-button.js's renderInventoryColdStart pattern; button
// reuses the existing .hs-mc-load-more style (no new button chrome).
function renderEmoteColdStart(channel) {
  const safeCh = escapeHtml(channel)
  return `
    <div class="hs-mc-picker-empty hs-mc-cold-start">
      <div class="hs-mc-cold-start-title">${escapeHtml(t('mc_emote_cold_start_title'))}</div>
      <div class="hs-mc-cold-start-sub">${escapeHtml(t('mc_emote_cold_start_sub', [channel]))}</div>
      <button type="button" class="hs-mc-load-more hs-mc-cold-start-import" data-channel="${safeCh}">${escapeHtml(t('mc_emote_cold_start_import', [channel]))}</button>
    </div>`
}

// One-click "import all of a channel's 7TV/BTTV/FFZ emotes into your set" —
// same server endpoint as chrome/heatsync-button.js's hsImportChannel.
async function hsMcImportChannelEmotes(btn, channel) {
  if (!channel || btn.disabled) return
  btn.disabled = true
  const label = btn.textContent
  btn.textContent = t('mc_emote_cold_start_importing')
  try {
    const platform = hostPlatform === 'yt' ? 'youtube' : hostPlatform || 'twitch'
    const resp = await apiFetch('/api/user/emotes/import-channel', {
      method: 'POST',
      auth: true,
      body: { channel, platform },
    })
    if (resp && resp.ok !== false) {
      const n = resp.data?.imported ?? resp.imported ?? resp.data?.count ?? '?'
      showToast(t('mc_emote_cold_start_imported', [String(n)]), 'success')
      markPickerDirty()
      await loadEmotes()
      showEmotePicker(pickerTab)
    } else {
      btn.textContent = t('mc_emote_cold_start_failed')
      showToast(resp?.error || t('mc_emote_cold_start_failed'), 'error')
      setTimeout(() => {
        btn.textContent = label
        btn.disabled = false
      }, 2000)
    }
  } catch (_) {
    btn.textContent = t('mc_emote_cold_start_failed')
    showToast(t('mc_emote_cold_start_failed'), 'error')
    setTimeout(() => {
      btn.textContent = label
      btn.disabled = false
    }, 2000)
  }
}

function emoteImgHtml([name, emote]) {
  const isBlocked = blockedEmoteNames.has(name)
  // 2-state picker: normal or blocked. `state` is still tracked on the img
  // dataset so findEmoteTarget can route blocked→unblock and the chat-row /
  // cross-user rendering pipelines that inspect it (lookupEmote, processEmotes)
  // keep working; visually the picker only renders the blocked dashed-rect or
  // nothing. The old green/orange "owned vs unadded" tier was confusing now
  // that 7TV discovery lives in tab-complete and slot fill happens silently
  // via auto-add-on-send — every emote in the picker is equally pasteable.
  const state = isBlocked ? 'blocked' : emote.state || 'global'
  // Category tell (decision surface): own-inventory entries carry cwCats
  // (server annotation, see hsOwnCwHiddenCat) — first category picks the
  // border color. Global/channel entries only ever have the nsfw bool, so
  // they fall back to the plain teal tell. Mirror of web's picker flagCat.
  const flagCat = Array.isArray(emote.cwCats) && emote.cwCats[0]
  const nsfwTag = emote.nsfw || flagCat ? ' hs-state-nsfw' : ''
  const cwAttr = flagCat ? ` data-cw="${escapeHtml(flagCat)}"` : ''
  const wrapCls = (isBlocked ? 'hs-mc-picker-emote-wrap blocked' : 'hs-mc-picker-emote-wrap') + nsfwTag
  const safeName = escapeHtml(name)
  return `<span class="${wrapCls}" data-name="${safeName}"${cwAttr}><img src="${escapeHtml(emote.url)}" alt="${safeName}" title="${safeName} (${escapeHtml(emote.source)})" class="hs-mc-picker-emote hs-emote-${escapeHtml(emote.source)}" data-name="${safeName}" data-source="${escapeHtml(emote.source)}" data-state="${state}" loading="lazy"></span>`
}

/**
 * Emote picker — DOM is built once and cached; subsequent opens just toggle
 * `.visible` (no innerHTML reparse). Idle prebuild after loadEmotes() makes
 * even the very first click open instantly. Cache invalidates on channel
 * switch, emote-size change, or any emote-cache reload via markPickerDirty().
 */
let pickerTab = 'emotes' // 'emotes' or 'twitch'
let _pickerCloseHandler = null
let _pickerBuiltKey = null
let _pickerPrebuildScheduled = false

function pickerCacheKey() {
  // pickerTab is intentionally NOT in the key — switching the active tab
  // (emotes ↔ twitch) just toggles display, no rebuild needed.
  const ch = currentTab || getCurrentChannel() || '_'
  const chSize = channelEmoteCaches[ch]?.size || channelEmoteCaches[getCurrentChannel()]?.size || 0
  // _blockedRev: a cross-device block/unblock (applyBlockedHashDelta) changes
  // no size here — without it a rebuild triggered by an unrelated key change
  // would be the only thing correcting a stale cached picker DOM.
  return `${ch}|${emoteSize}|${emoteCache.size}|${chSize}|${_blockedRev}`
}

function markPickerDirty() {
  _pickerBuiltKey = null
}

function prebuildPickerIdle() {
  if (_pickerPrebuildScheduled) return
  _pickerPrebuildScheduled = true
  // Firefox requires requestIdleCallback to be called with `this === window`;
  // a bare reference loses the binding and throws "called on an object that
  // does not implement interface Window". Bind explicitly, fall back to setTimeout.
  const idle = window.requestIdleCallback ? window.requestIdleCallback.bind(window) : (cb) => setTimeout(cb, 250)
  idle(
    () => {
      _pickerPrebuildScheduled = false
      if (typeof mcSignal !== 'undefined' && mcSignal.aborted) return
      const picker = document.getElementById('hs-mc-emote-picker')
      if (!picker) return
      // Don't rebuild while the user is actively inside the picker — the
      // innerHTML swap destroys the search input element + its typed value,
      // which manifests as "I clicked an emote and the picker reset to no
      // search". Cache key stays stale; next close+reopen rebuilds fresh.
      if (picker.classList.contains('visible')) return
      if (pickerCacheKey() !== _pickerBuiltKey) showEmotePicker('__prebuild')
    },
    { timeout: 1500 },
  )
}

function syncPickerTabDisplay(picker) {
  const emTab = picker.querySelector('#hs-mc-tab-emotes')
  const twTab = picker.querySelector('#hs-mc-tab-twitch')
  if (emTab) emTab.style.display = pickerTab === 'emotes' ? 'flex' : 'none'
  if (twTab) twTab.style.display = pickerTab === 'twitch' ? 'flex' : 'none'
  picker.querySelectorAll('.hs-mc-picker-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === pickerTab)
  })
}

function showEmotePicker(tab = null) {
  const picker = document.getElementById('hs-mc-emote-picker')
  if (!picker) return

  // Sentinel: prebuild path — populate DOM but do NOT toggle visible.
  const isPrebuild = tab === '__prebuild'
  if (isPrebuild) {
    // Skip if already built for the current state
    if (pickerCacheKey() === _pickerBuiltKey) return
    // Fall through to build path; visible class is left untouched at end.
  } else if (tab) {
    pickerTab = tab
  } else if (picker.classList.contains('visible')) {
    picker.classList.remove('visible')
    hideInputBar()
    return
  }

  // Twitch features tab (predictions/polls/rewards/clip/popout/mod) needs the
  // twitch.tv page context for auth + GQL proxy. Hide it on YT/Kick host.
  const showTwitchTab = hostPlatform === 'twitch'
  if (!showTwitchTab && pickerTab === 'twitch') pickerTab = 'emotes'

  // Cache hit → no rebuild, just sync which tab content is shown.
  if (!isPrebuild && pickerCacheKey() === _pickerBuiltKey && picker.firstChild) {
    syncPickerTabDisplay(picker)
    picker.classList.add('visible')
    syncPickerBox()
    // Now that the picker has layout, fill any chunks the IntersectionObserver
    // never got to (first open in a hidden/occluded tab — IO doesn't fire there).
    renderVisibleChunks(picker)
    if (pickerTab === 'twitch') renderTwitchTab()
    attachPickerCloseHandler(picker)
    return
  }

  // Cache miss → build full DOM synchronously (no chunks, no popping).
  // Merge channel emotes first (keeps 'channel' state), then globals.
  // All names/urls are pre-sanitized via escapeHtml in render helpers.
  const allEmotes = new Map()
  // Picker priority: viewer's personal inventory FIRST so 'owned' state shows on top
  for (const [k, v] of viewerPersonalEmotes) allEmotes.set(k, v)
  const chCache = channelEmoteCaches[currentTab] || channelEmoteCaches[getCurrentChannel()]
  if (chCache) for (const [k, v] of chCache) if (!allEmotes.has(k)) allEmotes.set(k, v)
  for (const [k, v] of emoteCache) if (!allEmotes.has(k)) allEmotes.set(k, v)
  const sections = groupEmotes(allEmotes)
  picker.innerHTML = `
      <div class="hs-mc-tab-content" id="hs-mc-tab-emotes" style="display: ${pickerTab === 'emotes' ? 'flex' : 'none'}; flex-direction: column;">
        <div class="hs-mc-picker-header">
          <div class="hs-mc-search-wrap">
            <svg class="hs-mc-search-icon" width="14" height="14" viewBox="0 0 20 20"><path fill="#000" d="M13.74 12.33l4.04 4.04a1 1 0 01-1.42 1.42l-4.04-4.04a7 7 0 111.42-1.42zM9 14A5 5 0 109 4a5 5 0 000 10z"/></svg>
            <input type="text" id="hs-mc-emote-search" placeholder="${t('mc_emote_search_placeholder')}" autocomplete="off">
          </div>
        </div>
        <div class="hs-mc-picker-scroll" id="hs-mc-emote-grid">
          ${renderEmoteSections(sections)}
        </div>
      </div>
      ${
        showTwitchTab
          ? `<div class="hs-mc-tab-content" id="hs-mc-tab-twitch" style="display: ${pickerTab === 'twitch' ? 'flex' : 'none'}; flex-direction: column; padding: 8px 0;">
        <div class="hs-mc-pred-loading">${t('common_loading')}</div>
      </div>
      <div class="hs-mc-picker-tabs">
        <button class="hs-mc-picker-tab ${pickerTab === 'emotes' ? 'active' : ''}" data-tab="emotes">emotes</button>
        <button class="hs-mc-picker-tab ${pickerTab === 'twitch' ? 'active' : ''}" data-tab="twitch">twitch</button>
      </div>`
          : ''
      }
    `

  // Inject provider filter chips INSIDE the search wrap (not as a sibling
  // below it) so they sit on the right edge of the search input. Single
  // bordered row makes it unambiguous that these chips filter the search
  // input, not the emote grid below. Always visible on the emotes tab.
  const searchWrap = picker.querySelector('.hs-mc-search-wrap')
  if (searchWrap && !searchWrap.querySelector('.hs-mc-src-chips')) {
    const chipBar = document.createElement('div')
    chipBar.className = 'hs-mc-src-chips visible'
    chipBar.title = 'toggle which providers to search'
    for (const src of MC_REMOTE_SOURCES) {
      const btn = document.createElement('button')
      btn.className = `hs-mc-src-chip${mcPickerSources.has(src) ? ' active' : ''}`
      btn.dataset.src = src
      btn.textContent = src
      btn.type = 'button'
      chipBar.appendChild(btn)
    }
    // Exact-match filter chip — precision toggle (exact name only). Orange
    // accent marks it as a HeatSync filter, distinct from the brand-colored
    // provider chips.
    const exactBtn = document.createElement('button')
    exactBtn.className = `hs-mc-exact-chip${mcExactMatch ? ' active' : ''}`
    exactBtn.textContent = t('mc_emote_exact')
    exactBtn.title = 'exact name match only'
    exactBtn.type = 'button'
    chipBar.appendChild(exactBtn)
    // Clicking a chip blurs the search input; preventDefault keeps focus.
    chipBar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.hs-mc-src-chip, .hs-mc-exact-chip')) e.preventDefault()
    })
    searchWrap.appendChild(chipBar)
  }

  // Source chip click handler — toggle, persist, re-search.
  // stopPropagation prevents the document-level outside-click handler from
  // firing when chips are clicked at narrow viewports where they overflow
  // the picker's visible bounds and land outside picker.contains(target).
  picker.querySelectorAll('.hs-mc-src-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation()
      const src = chip.dataset.src
      if (mcPickerSources.has(src)) mcPickerSources.delete(src)
      else mcPickerSources.add(src)
      chip.classList.toggle('active', mcPickerSources.has(src))
      mcSaveSources()
      const q = (document.getElementById('hs-mc-emote-search')?.value || '').toLowerCase().trim()
      if (!q) return
      if (mcHasExternalSource()) mcTriggerProviderSearches(q)
      rerenderSearch(q)
    })
  })

  // Exact-match chip — client-side filter, no refetch (results already cached).
  picker.querySelector('.hs-mc-exact-chip')?.addEventListener('click', (e) => {
    e.stopPropagation()
    mcExactMatch = !mcExactMatch
    e.currentTarget.classList.toggle('active', mcExactMatch)
    mcSaveExact()
    const q = (document.getElementById('hs-mc-emote-search')?.value || '').toLowerCase().trim()
    if (q) rerenderSearch(q)
  })

  // Search functionality (debounced). When external chips are on the query
  // fires the provider APIs (7TV v4 / BTTV / FFZ) in parallel. Local-only
  // mode keeps the original instant filter behaviour.
  let _searchTimer = null
  const searchInput = document.getElementById('hs-mc-emote-search')
  searchInput?.addEventListener('input', (e) => {
    cleanup.clearTimeout(_searchTimer)
    _searchTimer = cleanup.setTimeout(() => {
      const query = e.target.value.toLowerCase().trim()
      mcCurrentQuery = query
      if (query && mcHasExternalSource()) {
        mcTriggerProviderSearches(query)
      } else {
        mcTriggerProviderSearches('')
      }
      rerenderSearch(query)
    }, 200)
  })

  // rerenderSearch is now module-scope (mcRerenderSearch) so async provider
  // result callbacks can call it directly.
  const rerenderSearch = mcRerenderSearch

  // Emote size controls
  picker.querySelectorAll('.hs-mc-size-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const size = parseInt(btn.dataset.size, 10)
      setEmoteSize(size)
      // Update active state
      picker.querySelectorAll('.hs-mc-size-btn').forEach((b) => {
        b.classList.remove('active')
      })
      btn.classList.add('active')
    })
  })

  // Tab switching
  picker.querySelectorAll('.hs-mc-picker-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const newTab = tabBtn.dataset.tab
      const oldTab = pickerTab
      pickerTab = newTab
      picker.querySelectorAll('.hs-mc-picker-tab').forEach((t) => {
        t.classList.remove('active')
      })
      tabBtn.classList.add('active')
      picker.querySelectorAll('.hs-mc-tab-content').forEach((c) => {
        c.style.display = 'none'
      })
      const display = newTab === 'emotes' || newTab === 'settings' || newTab === 'twitch' ? 'flex' : 'block'
      document.getElementById(`hs-mc-tab-${newTab}`).style.display = display
      if (newTab === 'twitch') renderTwitchTab()
      if (oldTab === 'twitch' && newTab !== 'twitch') stopPredictionPoll()
    })
  })

  // Event delegation for emote clicks (single handler, works for chunked rendering).
  // Re-attach guard: must compare a PER-CONTEXT token, not a static version.
  // dataset lives on the shared DOM and survives an extension reload while
  // the listener's isolated world dies with the old context — a static
  // version check made the fresh context skip re-attach and every picker
  // click went dead until a full page refresh (hit live 2026-07-05 after a
  // night of dev reloads). The token is minted once per bundle eval, so a
  // new context always differs (re-attaches) and the same context never
  // double-attaches — robust regardless of expando/world visibility quirks.
  if (picker._hsClickCtx !== _HS_PICKER_CLICK_CTX) {
    picker._hsClickCtx = _HS_PICKER_CLICK_CTX
    picker.addEventListener('click', (e) => {
      // Cold-start import CTA (empty inventory) — one-click channel import.
      const coldBtn = e.target.closest('.hs-mc-cold-start-import')
      if (coldBtn) {
        e.stopPropagation()
        hsMcImportChannelEmotes(coldBtn, coldBtn.dataset.channel)
        return
      }
      const img = e.target.closest('.hs-mc-picker-emote')
      if (!img) return
      const name = img.dataset.name
      const input = document.getElementById('hs-mc-input')
      if (!input || !name) return

      // Remote (provider search) result — not yet in user's local emotes.
      // Optimistically register the emote in viewerPersonalEmotes so
      // pasteEmoteToInput resolves immediately (avoid the dead-click feel
      // from awaiting a network round-trip). The server-side add fires in
      // the background; on success the state is reconciled, on failure the
      // user still sees the emote (server sync re-evaluates next load).
      if (img.dataset.state === 'remote') {
        const remote = mcRemoteEmoteIndex.get(name)
        // Race-guard rapid double-clicks: addEmoteToInventory tracks in-flight adds
        // in pendingEmoteOps, so skip the optimistic-add + POST if one is already
        // running for this name — otherwise a fast second click fires a second
        // concurrent add POST (this was the only add entry point missing the guard).
        // The paste below still runs, so multi-click still inserts the emote each time.
        const _addInFlight = typeof pendingEmoteOps !== 'undefined' && pendingEmoteOps.has(name)
        if (remote && !_addInFlight) {
          const _optimistic = !viewerPersonalEmotes.has(name)
          if (_optimistic) {
            viewerPersonalEmotes.set(name, {
              url: remote.url,
              source: remote.provider || '7tv',
              state: 'owned',
              zeroWidth: !!remote.zeroWidth,
              addedAt: Date.now(),
            })
          }
          // Roll back the optimistic slot if the server add didn't take (e.g.
          // logged out) — otherwise the picker shows a phantom "owned" emote
          // with no real slot until the next reload (split-brain vs inventory).
          const _rollback = () => {
            if (_optimistic && !inventoryEmotes.has(name)) viewerPersonalEmotes.delete(name)
          }
          addEmoteToInventory(name, remote.url, remote.provider, img, !!remote.zeroWidth)
            .then((ok) => {
              if (!ok) _rollback()
            })
            .catch(_rollback)
        }
      }

      if (wysiwygEnabled || !('value' in input)) {
        pasteEmoteToInput(name)
      } else {
        recordRecentEmote(name)
        const pos = input.selectionStart || input.value.length
        const before = input.value.slice(0, pos)
        const after = input.value.slice(pos)
        const space = before.length > 0 && !before.endsWith(' ') ? ' ' : ''
        input.value = `${before + space + name} ${after}`
        pendingMessage = input.value
      }
      input.focus()
      // Stay open + flash, matching the input.js paste path for owned/global/
      // channel emotes — this delegate now only receives remote search results
      // (input.js eats every other state), and closing on those made search
      // multi-add feel broken next to grid multi-add.
      flashAllEmotes(name, 'hs-flash-paste')
    })

    // Provider search results land asynchronously — re-render when each one
    // arrives so the user sees the picture filling out instead of waiting
    // for the slowest provider.
    cleanup.addEventListener(
      document,
      'hs-mc-search-results-ready',
      (ev) => {
        if (ev.detail?.query !== mcCurrentQuery) return
        mcRerenderSearch(mcCurrentQuery)
      },
      'mc-search-results-ready',
    )
  }

  attachChunkObserver(picker)

  _pickerBuiltKey = pickerCacheKey()

  // Prebuild path stops here — DOM is ready, picker stays hidden.
  if (isPrebuild) return

  picker.classList.add('visible')
  syncPickerBox()
  // Picker now has layout — force-fill the visible chunks so a first open in a
  // hidden/occluded tab (where the IntersectionObserver never fires) isn't blank.
  renderVisibleChunks(picker)

  if (pickerTab === 'twitch') renderTwitchTab()

  attachPickerCloseHandler(picker)
}

let _pickerEscHandler = null
function attachPickerCloseHandler(picker) {
  if (_pickerCloseHandler) document.removeEventListener('click', _pickerCloseHandler)
  if (_pickerEscHandler) document.removeEventListener('keydown', _pickerEscHandler)
  cleanup.setTimeout(() => {
    _pickerCloseHandler = (e) => {
      if (mcSignal?.aborted) {
        document.removeEventListener('click', _pickerCloseHandler)
        _pickerCloseHandler = null
        return
      }
      if (!picker.contains(e.target) && !e.target.closest('#hs-mc-emote-btn')) {
        picker.classList.remove('visible')
        hideInputBar()
        stopPredictionPoll()
        document.removeEventListener('click', _pickerCloseHandler)
        _pickerCloseHandler = null
        document.removeEventListener('keydown', _pickerEscHandler)
        _pickerEscHandler = null
      }
    }
    _pickerEscHandler = (e) => {
      if (e.key !== 'Escape') return
      if (mcSignal?.aborted) {
        document.removeEventListener('keydown', _pickerEscHandler)
        _pickerEscHandler = null
        return
      }
      picker.classList.remove('visible')
      hideInputBar()
      stopPredictionPoll()
      document.removeEventListener('keydown', _pickerEscHandler)
      _pickerEscHandler = null
      document.removeEventListener('click', _pickerCloseHandler)
      _pickerCloseHandler = null
    }
    cleanup.addEventListener(document, 'click', _pickerCloseHandler, 'mc-picker-close')
    cleanup.addEventListener(document, 'keydown', _pickerEscHandler, 'mc-picker-esc')
  }, 0)
}

/** Size the open picker to exactly the message list's box.
 *
 * The picker used to be a fixed `min(400px, 60vh)` panel that the message list
 * shrank to make room for — on a tall chat that left a useless one-inch strip of
 * messages above a picker that still had to scroll. It now covers the whole chat
 * body instead: same top/height as #hs-mc-overlay, so the tab bar and the
 * composer stay visible and nothing has to reserve space for it.
 *
 * Mirroring the overlay's measured box (rather than per-layout top/bottom math)
 * is what makes this correct for every tab position, popout, and platform at
 * once — the overlay's box is already the answer to "where does chat live".
 */
function syncPickerBox() {
  const picker = document.getElementById('hs-mc-emote-picker')
  if (!picker?.classList.contains('visible')) return
  const overlay = document.getElementById('hs-mc-overlay')
  // No laid-out overlay (chat hidden, pre-mount) — leave the CSS box alone
  // rather than pinning height:0 and rendering an invisible picker.
  if (!overlay?.offsetHeight) return
  // offsetTop/offsetHeight are both relative to #hs-mc-container, which is the
  // picker's offsetParent too — no coordinate conversion, no reflow of others.
  picker.style.top = `${overlay.offsetTop}px`
  picker.style.height = `${overlay.offsetHeight}px`
  // !important: the per-tab-position layout rules pin `bottom` (some of them
  // with !important, which outranks a plain inline value), and top+height+bottom
  // together would over-constrain the box.
  picker.style.setProperty('bottom', 'auto', 'important')
}

// Blocked emotes: stored by HASH (matches background.js/server)
// blockedEmoteHashes = Set of hashes from storage
// blockedEmoteNames = Set of names (derived via hashToName lookup, for processEmotes)
let blockedEmoteHashes = new Set()
const blockedEmoteNames = new Set()
// Monotonic counter bumped whenever a name-resolvable block/unblock lands via
// applyBlockedHashDelta (cross-device push) — folded into pickerCacheKey so a
// picker rebuild triggered by an unrelated cache-key change (channel switch,
// emote count) doesn't serve pre-delta picker DOM. Local blockEmote/
// unblockEmote already patch picker wraps in place, so they don't need this.
let _blockedRev = 0

function rebuildBlockedNames() {
  blockedEmoteNames.clear()
  for (const hash of blockedEmoteHashes) {
    const name = hashToName.get(hash)
    if (name) blockedEmoteNames.add(name)
  }
  // Names persisted at block time — survive refresh even when hashToName can't
  // map the hash (blocked emote removed from set / not in any loaded cache).
  for (const name of blockedEmoteFallback.keys()) blockedEmoteNames.add(name)
  log(
    'Blocked names rebuilt:',
    blockedEmoteNames.size,
    'from',
    blockedEmoteHashes.size,
    'hashes +',
    blockedEmoteFallback.size,
    'fallback',
  )
}

async function loadBlockedEmotes() {
  try {
    const data = await chrome.storage.local.get(['blocked_emotes'])
    blockedEmoteHashes = new Set(data.blocked_emotes || [])
    rebuildBlockedNames()
    log('Loaded', blockedEmoteHashes.size, 'blocked emote hashes')
  } catch (e) {
    log('Error loading blocked emotes:', e)
  }
}

// Diff-apply blocked changes from storage WITHOUT re-rendering the whole tab.
// The full-rerender path in the storage onChanged listener was the source of
// the right-click flicker (only at scroll-bottom, since renderMessages was
// gated on !isScrolledUp) and could revert a fresh optimistic toggle if
// storage hadn't caught up yet. This applies only the actual hash deltas.
function applyBlockedHashDelta(newHashesArr) {
  const newSet = new Set(newHashesArr || [])
  const toBlock = []
  for (const h of newSet) if (!blockedEmoteHashes.has(h)) toBlock.push(h)
  const toUnblock = []
  for (const h of blockedEmoteHashes) if (!newSet.has(h)) toUnblock.push(h)
  if (toBlock.length === 0 && toUnblock.length === 0) return
  const changedNames = []

  for (const hash of toBlock) {
    const name = hashToName.get(hash)
    blockedEmoteHashes.add(hash)
    if (!name) continue
    blockedEmoteNames.add(name)
    changedNames.push(name)
    // Persist the name (+url when resolvable) to the block fallback so a
    // cross-device block survives reload even when hashToName can't resolve the
    // hash next session (e.g. a sender-personal 7TV emote in no loaded cache).
    // Mirrors blockEmote's local path; persist is debounced/single-flight.
    {
      const _be = lookupEmote(name)
      const _u = typeof _be?.url === 'string' && /^https?:\/\//i.test(_be.url) ? _be.url : ''
      rememberBlockedEmote(name, _u, _be?.source || 'heatsync', _be?.zeroWidth)
    }
    queryEmoteWrappers(name).forEach((w) => {
      if (w.classList.contains('hs-state-blocked')) return
      w.classList.remove(
        'hs-state-global',
        'hs-state-channel',
        'hs-state-owned',
        'hs-state-unadded',
        'hs-emote-highlight',
      )
      w.classList.add('hs-state-blocked')
      w.dataset.state = 'blocked'
      const img = w.querySelector('img')
      if (img) {
        img.classList.remove('hs-emote-global', 'hs-emote-channel', 'hs-emote-owned', 'hs-emote-unadded')
        img.classList.add('hs-emote-blocked')
        img.dataset.state = 'blocked'
      }
    })
    // Cross-device block also has to reach the picker grid — mirrors
    // blockEmote's picker patch (the local-block path); without this a
    // WS-pushed block from another device leaves the picker tile pasteable.
    try {
      document.querySelectorAll(`.hs-mc-picker-emote-wrap[data-name="${CSS.escape(name)}"]`).forEach((w) => {
        w.classList.add('blocked')
        const img = w.querySelector('img')
        if (img) img.dataset.state = 'blocked'
      })
    } catch {}
    applyInputEmoteBlockState(name, true)
  }

  for (const hash of toUnblock) {
    const name = hashToName.get(hash)
    blockedEmoteHashes.delete(hash)
    if (!name) continue
    blockedEmoteNames.delete(name)
    changedNames.push(name)
    // Drop the persisted fallback too, else rebuildBlockedNames re-seeds this
    // name from blockedEmoteFallback on the next reload and the emote re-blocks
    // itself. Mirrors unblockEmote's cleanup; persist is debounced.
    if (blockedEmoteFallback.delete(name)) persistBlockedFallback()
    const emote = lookupEmote(name)
    const realUrl = emote?.url || ''
    // 2-state model: block never dropped this from the set (server preserves
    // user_emotes through block now), so restore to the natural state per
    // current inventory membership — owned if still in the slot map, channel/
    // global otherwise. No special-cased "heatsync→unadded" branch.
    const src = emote?.source || 'heatsync'
    const newState = getEmoteState(name, src)
    queryEmoteWrappers(name).forEach((w) => {
      if (w.classList.contains(`hs-state-${newState}`)) return
      w.classList.remove(
        'hs-state-global',
        'hs-state-channel',
        'hs-state-owned',
        'hs-state-blocked',
        'hs-state-unadded',
        'hs-emote-highlight',
      )
      w.classList.add(`hs-state-${newState}`)
      w.dataset.state = newState
      w.style.outline = ''
      const img = w.querySelector('img')
      if (img && realUrl) {
        img.src = realUrl
        img.style.width = ''
        img.style.height = ''
        img.classList.remove(
          'hs-emote-global',
          'hs-emote-channel',
          'hs-emote-owned',
          'hs-emote-blocked',
          'hs-emote-unadded',
        )
        img.classList.add(`hs-emote-${newState}`)
        img.dataset.state = newState
      }
    })
    // Cross-device unblock — mirrors unblockEmote's picker patch.
    try {
      document.querySelectorAll(`.hs-mc-picker-emote-wrap[data-name="${CSS.escape(name)}"]`).forEach((w) => {
        w.classList.remove('blocked')
        const img = w.querySelector('img')
        if (img) img.dataset.state = newState
      })
    } catch {}
    applyInputEmoteBlockState(name, false)
  }

  if (changedNames.length) _blockedRev++

  // Cached _renderedHtml on buffered messages bakes in `hs-state-blocked` from
  // the moment the message was first processed. Without invalidation, any later
  // re-render (clicking "new messages", tab switch, scroll resume) replays the
  // stale state for non-heatsync emotes — the post-render correction loop only
  // touches data-source="heatsync" wrappers. Invalidate ONLY the messages that
  // reference the changed emotes (no global epoch bump → no whole-chat rebuild
  // flash); live DOM was already corrected in-place above.
  if (typeof invalidateRenderedForEmotes === 'function') invalidateRenderedForEmotes(changedNames)
}

// Flash all wrappers for a given emote name. Also touches multichat input
// chips (.hs-input-emote IMGs) so the user gets the same red/green ring
// feedback on the emote they just blocked/unblocked from the input.
function flashAllEmotes(emoteName, flashClass) {
  const wrappers = queryEmoteWrappers(emoteName)
  const inputImgs = []
  for (const img of document.querySelectorAll('img.hs-input-emote')) {
    if (img.alt === emoteName || img.dataset.emoteName === emoteName) inputImgs.push(img)
  }
  const targets = wrappers.length === 0 ? inputImgs : [...wrappers, ...inputImgs]
  if (targets.length === 0) return
  // Batch read/write to avoid per-element reflow
  for (const t of targets) {
    t.classList.remove('hs-flash-paste', 'hs-flash-add', 'hs-flash-block', 'hs-flash-unblock', 'hs-flash-remove')
  }
  // Single reflow trigger for all elements
  void document.body.offsetWidth
  for (const t of targets) {
    t.classList.add(flashClass)
    const clear = () => t.classList.remove(flashClass)
    t.addEventListener('animationend', clear, { once: true })
    // animationend never fires if the tab is backgrounded / the animation is
    // throttled mid-run, leaving a stuck glow that reads as jitter. Force-clear
    // just past the 0.4s animation window so the flash can never persist.
    cleanup.setTimeout(clear, 600)
  }
}

// Create emote <img> for WYSIWYG input. Resolves zero-width + "name0"
// overlay convention so img.src points at the actual emote (TriHard) while
// alt/dataset preserves the typed name (TriHard0) for round-trip on send.
function createInputEmoteImg(emoteName) {
  const resolved = lookupEmoteWithOverlay(emoteName)
  if (!resolved) return null
  const { emote, isOverlay } = resolved
  const img = document.createElement('img')
  img.className = 'hs-input-emote'
  img.src = getChatResUrl(emote.url)
  img.alt = emoteName
  img.dataset.emoteName = emoteName
  img.draggable = false
  // Persist state + source on the chip so findEmoteTarget (input.js:752) reads
  // 'owned' instead of defaulting to 'global'. Without this, right-clicking a
  // wavE chip in the input fell into the else branch and tried to BLOCK an
  // emote you own; left-click hover also missed its green-state CSS. Match
  // resolved emote.state ('owned'/'global'/'channel'/'unadded') 1:1.
  const _resolvedSource = emote.source || detectEmoteSource(emote.url)
  img.dataset.source = _resolvedSource
  // Owned shadows global/channel — surface what the user actually controls.
  img.dataset.state = inventoryEmotes.has(emoteName) ? 'owned' : emote.state || 'global'
  img.classList.add(`hs-state-${img.dataset.state}`)
  // Category tell follows the emote into the input chip (decision surface) —
  // same cwCats source the picker cell reads, first category wins.
  const _chipFlagCat = Array.isArray(emote.cwCats) && emote.cwCats[0]
  if (emote.nsfw || _chipFlagCat) {
    img.classList.add('hs-state-nsfw') // v1.6 cyan dashed
    if (_chipFlagCat) img.dataset.cw = _chipFlagCat
  }
  if (isOverlay) img.dataset.zeroWidth = '1'
  // Broken-image recovery — shared helper in input.js (cache-bust retry then
  // text fallback). Defined later in the bundle but function declarations
  // hoist to IIFE scope so it's available when this runs.
  if (typeof attachInputEmoteErrorRecovery === 'function') attachInputEmoteErrorRecovery(img)
  // If the emote was already blocked before this paste, apply the dashed
  // state from creation so the user never sees the live image flash.
  // "name0" resolving to a blocked base ("TriHard0" -> blocked "TriHard") must
  // also render blocked — only when there's no literal "name0" emote of its
  // own (mirrors _synthOverlay in findEmoteMatches/_applyInputBlock, input.js).
  // Hash check catches the same asset re-listed under a different alias.
  const _chipBlockedByBase =
    isOverlay &&
    emoteName.length > 1 &&
    emoteName.endsWith('0') &&
    !lookupEmoteRenderOrder(emoteName) &&
    blockedEmoteNames.has(emoteName.slice(0, -1))
  const _chipBlockedByHash = !!(emote.hash && blockedEmoteHashes.has(String(emote.hash)))
  if (blockedEmoteNames.has(emoteName) || _chipBlockedByBase || _chipBlockedByHash) markInputEmoteBlocked(img, true)
  // Snap the chip to an integer width once decoded. A non-square emote scaled
  // to the row height lands on a fractional width, so every character typed
  // AFTER it starts at a fractional x and the bitmap font smears — the same
  // horizontal fault chat rows fix via the load listener on #hs-mc-messages,
  // which never covered the composer. Hook the chip directly (it's created in
  // code) and cover the already-cached case, where load never fires.
  if (typeof hsAttachInputEmoteSnap === 'function') hsAttachInputEmoteSnap(img)
  return img
}

// 1×1 transparent gif — swap src to this so the IMG box stays paintable
// (visibility:hidden / opacity:0 would also drop the outline).
const HS_TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function markInputEmoteBlocked(img, blocked) {
  if (!img) return
  if (blocked) {
    if (img.dataset.hsInputBlocked === '1') return
    img.dataset.hsInputBlocked = '1'
    if (img.src && !img.src.startsWith('data:')) img.dataset.hsOrigSrc = img.src
    img.src = HS_TRANSPARENT_PX
    img.classList.add('hs-state-blocked')
    // Stash the real ownership state so unblock can restore it, instead of
    // leaving the chip stateless (findEmoteTarget would then default to 'global'
    // and mis-route the right-click/hover menu on an owned emote).
    if (img.dataset.state && img.dataset.state !== 'blocked') img.dataset.hsPrevState = img.dataset.state
    // dataset.state lets findEmoteTarget (input.js) and the chrome content.js
    // hover-overlay color picker route through the blocked branch even when
    // src is the transparent placeholder.
    img.dataset.state = 'blocked'
  } else {
    if (img.dataset.hsInputBlocked !== '1') return
    const orig = img.dataset.hsOrigSrc
    if (orig) img.src = orig
    delete img.dataset.hsInputBlocked
    delete img.dataset.hsOrigSrc
    img.classList.remove('hs-state-blocked')
    if (img.dataset.hsPrevState) {
      img.dataset.state = img.dataset.hsPrevState
      delete img.dataset.hsPrevState
    } else {
      delete img.dataset.state
    }
  }
}

// Update every .hs-input-emote IMG matching the name across both the
// multichat input and any cycling/preview imgs that share the class. Match
// by alt + dataset.emoteName (both set at creation; alt may be the typed
// overlay name like "TriHard0" while dataset is identical).
function applyInputEmoteBlockState(emoteName, blocked) {
  if (!emoteName) return
  const inputs = document.querySelectorAll('img.hs-input-emote')
  for (const img of inputs) {
    if (img.alt !== emoteName && img.dataset.emoteName !== emoteName) continue
    // Render the dashed box in place — same as chat/picker. The chip keeps its
    // alt/dataset.emoteName so getInputText still serializes the name on send
    // (recipient renders the emote unless they too blocked it). Removing the
    // chip instead left the contenteditable with a stale caret/draft, which
    // showed up as doubled overlapping text.
    markInputEmoteBlocked(img, blocked)
  }
}

// Stack a zero-width emote onto a base emote/stack in the input.
// Tags the new overlay child with hs-input-overlay so CSS can render it at
// native size (chat parity) while the base stays clamped to emote-size.
function stackInputEmote(baseEl, overlayImg) {
  overlayImg.classList.add('hs-input-overlay')
  if (baseEl.classList.contains('hs-input-stack')) {
    baseEl.appendChild(overlayImg)
    return baseEl
  }
  const stack = document.createElement('span')
  stack.className = 'hs-input-stack'
  // Atomic inline unit — cursor can't enter, typed text stays on the
  // outside line instead of getting trapped as a child grid cell.
  stack.setAttribute('contenteditable', 'false')
  baseEl.parentNode.insertBefore(stack, baseEl)
  stack.appendChild(baseEl)
  stack.appendChild(overlayImg)
  return stack
}

// Find last emote element (img or stack) walking backwards, skipping whitespace
function findLastInputEmote(input) {
  let node = input.lastChild
  while (node) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() === '') {
      node = node.previousSibling
      continue
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'IMG' && node.classList.contains('hs-input-emote')) return node
      if (node.classList?.contains('hs-input-stack')) return node
      // Emoji span is a valid overlay base (chat stacks overlays onto emoji).
      if (node.classList?.contains('hs-mc-emoji')) return node
    }
    break
  }
  return null
}

// Move cursor to end of input
function cursorToEnd(input) {
  const range = document.createRange()
  range.selectNodeContents(input)
  range.collapse(false)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

// Parse a space-separated modifier-word string ("w! h! c!#888") into
// canonical {mods, hue, words}; skips tokens that don't classify as modifiers
// so a stray non-modifier word can't poison the result.
function _hsMcParseModWords(s) {
  const mods = []
  let hue = null
  const words = []
  for (const w of (s || '').trim().split(/\s+/).filter(Boolean)) {
    const c = hsModClassify(w, { allowPrefix: false })
    if (c.kind !== 'modifier') continue
    if (c.mods) for (const m of c.mods) mods.push(m)
    if (c.hue != null) hue = c.hue
    if (c.words) for (const ww of c.words) words.push(ww)
  }
  return { mods, hue, words }
}

// Paste emote name to input. Optional modWords ("w! h!") restores the
// exact dimensions from a source chip — left-click on an emote nest passes
// each wrapper's wire words so paste→send produces identical sizing.
function pasteEmoteToInput(emoteName, modWords) {
  const input = document.getElementById('hs-mc-input')
  if (!input) return
  recordRecentEmote(emoteName)
  const _applyMods = (img) => {
    if (!img || !modWords) return
    const { mods, hue, words } = _hsMcParseModWords(modWords)
    if (mods.length || hue != null || words.length) {
      hsModApplyToImg(img, mods, hue, words)
    }
  }
  if (wysiwygEnabled || !('value' in input)) {
    const img = createInputEmoteImg(emoteName)
    if (img) {
      _applyMods(img)
      // createInputEmoteImg already resolved overlay status (zeroWidth flag
      // OR "name0" convention) and tagged the img — reuse it for parity with
      // the typed live-replace path.
      const isZeroWidth = img.dataset.zeroWidth === '1'

      if (isZeroWidth) {
        const target = findLastInputEmote(input)
        if (target) {
          // Remove trailing whitespace between target and end
          let next = target.nextSibling
          while (next) {
            if (next.nodeType === Node.TEXT_NODE && next.textContent.trim() === '') {
              const rm = next
              next = next.nextSibling
              rm.remove()
            } else break
          }
          stackInputEmote(target, img)
          input.appendChild(document.createTextNode('\u00A0'))
          cursorToEnd(input)
          pendingMessage = getInputText()
          input.focus()
          return
        }
      }

      // Regular emote: append img + space
      input.appendChild(img)
      input.appendChild(document.createTextNode('\u00A0'))
      cursorToEnd(input)
    } else {
      // Fallback: emote not in cache, insert as text
      const text = input.textContent || ''
      const space = text.length > 0 && !text.endsWith(' ') ? ' ' : ''
      const modTail = modWords ? ` ${modWords.trim()}` : ''
      input.textContent = `${text + space + emoteName + modTail} `
      cursorToEnd(input)
    }
    pendingMessage = getInputText()
  } else {
    const pos = input.selectionStart || input.value.length
    const before = input.value.slice(0, pos)
    const after = input.value.slice(pos)
    const space = before.length > 0 && !before.endsWith(' ') ? ' ' : ''
    const modTail = modWords ? ` ${modWords.trim()}` : ''
    const insert = `${emoteName + modTail} `
    input.value = before + space + insert + after
    pendingMessage = input.value
    input.selectionStart = input.selectionEnd = pos + space.length + insert.length
  }
  input.focus()
}

// Paste an emoji span (from a chat-rendered nest) into the input. asOverlay
// stacks onto the previous chip so the nest's base+overlay composition is
// reproduced — getInputText then emits ":name:0" for overlay emojis on send.
// Chat-rendered emoji spans carry the shortcode in title=":name:" (no
// data-emoji-name) so we recover it from there; raw unicode emojis have no
// title and round-trip as the unicode char.
function pasteEmojiSpanFromNestToInput(srcSpan, asOverlay) {
  const input = document.getElementById('hs-mc-input')
  if (!input || !srcSpan) return
  const span = document.createElement('span')
  span.className = 'hs-mc-emoji'
  span.textContent = srcSpan.textContent || ''
  span.setAttribute('contenteditable', 'false')
  const t = srcSpan.getAttribute('title') || ''
  const m = t.match(/^:([a-z0-9_+-]+):$/i)
  if (m) {
    span.setAttribute('data-emoji-name', m[1])
    span.title = t
  }
  const wireWords = srcSpan.dataset?.hsWords || srcSpan.getAttribute('data-hs-words') || ''
  if (wireWords) span.setAttribute('data-hs-words', wireWords)
  if (asOverlay) {
    const target = findLastInputEmote(input)
    if (target) {
      let next = target.nextSibling
      while (next) {
        if (next.nodeType === Node.TEXT_NODE && next.textContent.trim() === '') {
          const rm = next
          next = next.nextSibling
          rm.remove()
        } else break
      }
      stackInputEmote(target, span)
      input.appendChild(document.createTextNode(' '))
      cursorToEnd(input)
      pendingMessage = getInputText()
      return
    }
  }
  // Base insert — pad away from any preceding chip so chip-merge safeguards
  // don't collapse adjacent emoji spans back into plain text.
  const last = input.lastChild
  const needPad =
    last &&
    (last.nodeType === Node.ELEMENT_NODE || (last.nodeType === Node.TEXT_NODE && !/\s$/.test(last.textContent || '')))
  if (needPad) input.appendChild(document.createTextNode(' '))
  input.appendChild(span)
  input.appendChild(document.createTextNode(' '))
  cursorToEnd(input)
  pendingMessage = getInputText()
}

// Right-click an owned emote in multichat removes it from your HS inventory and
// the name falls back to its next-in-line source (channel/global) or plain text —
// mirroring heatsync.org. The call site (input.js) gates this to genuine inventory
// emotes (state==='owned' && inventoryEmotes.has) so subs / channel / bits are
// never removable, and removal is reversible (30-day recovery on the backend) —
// which is what made the old accidental-vanish concern safe to revisit.
async function removeEmoteFromInventory(emoteName, targetEl) {
  if (!emoteName) return
  pendingEmoteOps.add(emoteName)
  try {
    await _removeEmoteFromInventory(emoteName, targetEl)
  } finally {
    pendingEmoteOps.delete(emoteName)
  }
}

async function _removeEmoteFromInventory(emoteName, targetEl) {
  const wrapper = targetEl?.closest?.('.hs-mc-emote-wrapper') || targetEl
  const emoteHash =
    inventoryHashes.get(emoteName) ||
    wrapper?.dataset?.emoteHash ||
    emoteHashes.get(emoteName) ||
    lookupEmote(emoteName)?.hash ||
    emoteName
  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'remove_from_inventory', emoteHash, emoteName }, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve(resp)
      })
    })
    // Server is authoritative: treat "not found in your set" as already-removed so a
    // stale 'owned' state can't trap the user looping on a failing remove.
    if (response?.success || (response?.error && /not found in your set/i.test(response.error))) {
      handleRemoveSuccess(emoteName)
    } else {
      showToast(response?.error || t('mc_emote_remove_failed', [emoteName]), 'error')
    }
  } catch (_) {
    showToast(t('mc_emote_remove_error', [emoteName]), 'error')
  }
}

function handleRemoveSuccess(emoteName) {
  // Capture BEFORE the delete below strips the entry — keeps this emote's
  // history resolvable so the viewer's own past messages that used it still
  // render the image (as unadded, not owned) instead of raw text after a
  // refresh. Mirrors blockEmote's capture-before-mutate pattern; this entry
  // is guaranteed present here since the only caller (input.js) gates the
  // remove path on inventoryEmotes.has(emoteName).
  const _re = viewerPersonalEmotes.get(emoteName)
  if (_re?.url) rememberRemovedEmote(emoteName, _re.url, _re.source, _re.zeroWidth)
  inventoryEmotes.delete(emoteName)
  inventoryHashes.delete(emoteName)
  viewerPersonalEmotes.delete(emoteName)
  // Drop from the tab-complete auto-add registry so re-posting doesn't silently re-add it.
  if (typeof recentRemoteCompletions !== 'undefined') recentRemoteCompletions.delete(emoteName)
  // Vanish the picker thumbnail(s) + keep section counts truthful; rebuild on reopen.
  try {
    const wraps = document.querySelectorAll(`.hs-mc-picker-emote-wrap[data-name="${CSS.escape(emoteName)}"]`)
    const sections = new Set()
    wraps.forEach((w) => {
      const sec = w.closest('.hs-mc-picker-section')
      if (sec) sections.add(sec)
      w.remove()
    })
    for (const sec of sections) {
      const count = sec.querySelector('.hs-mc-picker-section-count')
      if (count) {
        const n = parseInt(count.textContent, 10)
        if (!Number.isNaN(n) && n > 0) count.textContent = String(n - 1)
      }
    }
  } catch {}
  markPickerDirty()
  // Re-resolve the name in rendered chat. Dropping it from viewerPersonalEmotes
  // (above) makes processEmotes fall through to channel/global, or plain text if
  // nothing else is named that. We intentionally leave channel/global caches intact
  // so the fallback emote still resolves. Invalidate cached renders + reprocess
  // visible rows so existing messages update in place instead of keeping the
  // removed image. (typeof guards: these live in main.js, loaded after this module.)
  if (typeof invalidateRenderedForEmotes === 'function') invalidateRenderedForEmotes([emoteName])
  if (typeof reprocessEmoteTextInPlace === 'function') reprocessEmoteTextInPlace()
  showToast(t('mc_emote_removed', [emoteName]), 'success')
}

function blockAllEmotesInStack(stack) {
  const wrappers = stack.querySelectorAll('.hs-mc-emote-wrapper')
  let count = 0
  wrappers.forEach((w) => {
    const name = w.dataset.emoteName
    if (name && w.dataset.state !== 'blocked') {
      blockEmote(name, w.dataset.emoteUrl || w.querySelector('img')?.src, w.dataset.source)
      count++
    }
  })
  if (count > 0) showToast(t('mc_emote_blocked_count', [String(count)]), 'success')
  stack.classList.remove('expanded')
  stack.setAttribute('title', 'expand')
}

// opts.skipSync: don't hit the API (used when this call IS the rollback of a
// failed unblock — reversing it must not fire another server write).
// opts.silent: suppress the success toast (a rollback speaks through the error
// toast at the failure site, not a second "blocked" line).
function blockEmote(emoteName, clickedUrl, clickedSource, opts) {
  if (!emoteName) return

  // Capture url/source BEFORE the deletes below strip the emote from caches —
  // persists the name so the dashed box renders after refresh, and the url so
  // unblock + re-add can restore the real image. Prefer a cache hit, then the
  // url of the element that was clicked to block (a visible emote always has a
  // real url) — without this, blocking an emote that lookupEmote can't resolve
  // stored no url, leaving it un-re-addable (renders blank on re-add).
  const _be = lookupEmote(emoteName)
  const _httpOk = (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
  // Prefer the CLICKED element's url (the actually-rendered image — channel
  // version when a name exists both channel + global) over lookupEmote, which
  // returns the global cache first and would otherwise capture the wrong image
  // for unblock/re-add.
  const capturedUrl = _httpOk(clickedUrl) ? clickedUrl : _httpOk(_be?.url) ? _be.url : ''
  rememberBlockedEmote(emoteName, capturedUrl, _be?.source || clickedSource, _be?.zeroWidth)

  // 2-state model: block is a render-preference, not an inventory mutation.
  // Preserve inventoryEmotes / inventoryHashes / viewerPersonalEmotes so an
  // immediate unblock returns the emote to "set" instead of falling through
  // to global. Server-side matches (blocking.ts no longer DELETEs the
  // user_emotes row), so this local preservation stays consistent across
  // tab restarts + inventory refetches.
  blockedEmoteNames.add(emoteName)

  // Get hash for API - prefer known hash, then url-derived (capturedUrl covers
  // the case lookupEmote misses), last resort the name.
  const hash = emoteHashes.get(emoteName) || (capturedUrl ? btoa(capturedUrl).slice(0, 32) : emoteName)
  blockedEmoteHashes.add(hash)

  // Sync to heatsync.org API via background.js (it handles storage). The
  // success/failure toast now lives INSIDE syncBlockToAPI — the DOM update
  // above is optimistic, and a confirmed server rejection rolls it back there
  // rather than leaving a "blocked ✓" the next inventory refetch silently
  // undoes. Pass the captured url/source so a failed-unblock rollback can
  // restore the real image.
  if (!opts?.skipSync)
    syncBlockToAPI(emoteName, true, { url: capturedUrl, source: _be?.source || clickedSource, silent: opts?.silent })

  // Instant DOM update - CSS visibility:hidden hides the img, no src swap needed
  queryEmoteWrappers(emoteName).forEach((w) => {
    w.classList.remove(
      'hs-state-global',
      'hs-state-channel',
      'hs-state-owned',
      'hs-state-unadded',
      'hs-emote-highlight',
    )
    w.classList.add('hs-state-blocked')
    w.dataset.state = 'blocked'
    const img = w.querySelector('img')
    if (img) {
      img.classList.remove('hs-emote-global', 'hs-emote-channel', 'hs-emote-owned', 'hs-emote-unadded')
      img.classList.add('hs-emote-blocked')
      img.dataset.state = 'blocked'
    }
  })

  // Update any picker thumbnails for this emote (the existing wrapper update
  // path only touches chat messages, not the picker grid). Toggling state on
  // the img too so the global right-click handler reads it as 'blocked' and
  // routes to unblockEmote on the next right-click.
  try {
    document.querySelectorAll(`.hs-mc-picker-emote-wrap[data-name="${CSS.escape(emoteName)}"]`).forEach((w) => {
      w.classList.add('blocked')
      const img = w.querySelector('img')
      if (img) img.dataset.state = 'blocked'
    })
  } catch {}

  applyInputEmoteBlockState(emoteName, true)

  refreshEmoteTooltip(emoteName, 'blocked')
  // Success toast fires from syncBlockToAPI on confirmation (or immediately for
  // the logged-out local path). skipSync means there's no confirmation coming,
  // so a non-silent skipSync still owes a toast; silent (rollback) owes none.
  if (opts?.skipSync && !opts?.silent) showToast(t('mc_emote_blocked_toast', [emoteName]), 'success')
  flashAllEmotes(emoteName, 'hs-flash-block')
  // Surgical: only re-key messages that reference this emote (no epoch bump →
  // no whole-chat rebuild flash). Live DOM already updated in-place above.
  if (typeof invalidateRenderedForEmotes === 'function') invalidateRenderedForEmotes(emoteName)
}

// Re-apply current state to all rendered wrappers for `emoteName`. Use after
// inventory changes to keep the wrapper's hs-state-* class in sync with the
// current owned/global/channel resolution (visually identical under 2-state,
// but the dataset.state attr drives auto-add-on-send gating downstream).
// Never overrides hs-state-blocked — that branch is owned by block/unblock.
function refreshEmoteWrappersState(emoteName) {
  if (!emoteName) return
  const emote = lookupEmote(emoteName)
  const newState = emote ? getEmoteState(emoteName, emote.source) : 'unadded'
  queryEmoteWrappers(emoteName).forEach((w) => {
    if (w.classList.contains('hs-state-blocked')) return
    w.classList.remove('hs-state-global', 'hs-state-channel', 'hs-state-owned', 'hs-state-unadded')
    w.classList.add(`hs-state-${newState}`)
    w.dataset.state = newState
    const img = w.querySelector('img')
    if (img) {
      img.classList.remove('hs-emote-global', 'hs-emote-channel', 'hs-emote-owned', 'hs-emote-unadded')
      img.classList.add(`hs-emote-${newState}`)
      img.dataset.state = newState
    }
  })
}

function unblockEmote(emoteName, opts) {
  if (!emoteName) return

  // Update local tracking
  blockedEmoteNames.delete(emoteName)
  const hash =
    emoteHashes.get(emoteName) ||
    (lookupEmote(emoteName)?.url ? btoa(lookupEmote(emoteName).url).slice(0, 32) : emoteName)
  blockedEmoteHashes.delete(hash)
  // Drop the persisted block fallback so it can't re-seed blockedEmoteNames on
  // the next refresh (which would re-hide an emote the user just unblocked).
  const _bfEmote = blockedEmoteFallback.get(emoteName)
  if (blockedEmoteFallback.delete(emoteName)) persistBlockedFallback()

  // Sync to heatsync.org API via background.js. Toast + optimistic-rollback
  // live in syncBlockToAPI (see blockEmote). Carry the fallback url/source so a
  // failed-block rollback (i.e. this unblock reversing a block) is redundant,
  // but a failed UNBLOCK rollback re-blocks and needs them.
  if (!opts?.skipSync)
    syncBlockToAPI(emoteName, false, { url: _bfEmote?.url || '', source: _bfEmote?.source, silent: opts?.silent })

  // Instant DOM update - restore images. After refresh the emote is in no live
  // cache, so lookupEmote misses — fall back to the persisted block url.
  const emote = lookupEmote(emoteName)
  const realUrl = emote?.url || _bfEmote?.url || ''
  // 2-state model: unblock returns the emote to whatever its natural state is
  // now (owned if it's in the viewer's inventory, channel if scoped to the
  // current channel, global otherwise). The old code forced 'unadded' (orange)
  // as a middle tier on the ladder; with the ladder gone, unblock is simply
  // "stop hiding this," and the natural state restores green-equivalent
  // highlight color across chat-row + picker.
  const newState =
    typeof getEmoteState === 'function' ? getEmoteState(emoteName, emote?.source) : emote?.state || 'global'
  queryEmoteWrappers(emoteName).forEach((w) => {
    w.classList.remove(
      'hs-state-global',
      'hs-state-channel',
      'hs-state-owned',
      'hs-state-blocked',
      'hs-state-unadded',
      'hs-emote-highlight',
    )
    w.classList.add(`hs-state-${newState}`)
    w.dataset.state = newState
    w.style.outline = ''
    const img = w.querySelector('img')
    if (img && realUrl) {
      img.src = realUrl
      img.style.width = ''
      img.style.height = ''
      img.classList.remove(
        'hs-emote-global',
        'hs-emote-channel',
        'hs-emote-owned',
        'hs-emote-blocked',
        'hs-emote-unadded',
      )
      img.classList.add(`hs-emote-${newState}`)
      img.dataset.state = newState
    }
  })

  // Also drop the dashed outline on any picker thumbnails for this emote so
  // they go back to looking like normal pasteable emotes.
  try {
    document.querySelectorAll(`.hs-mc-picker-emote-wrap[data-name="${CSS.escape(emoteName)}"]`).forEach((w) => {
      w.classList.remove('blocked')
      const img = w.querySelector('img')
      if (img) img.dataset.state = newState
    })
  } catch {}

  applyInputEmoteBlockState(emoteName, false)

  refreshEmoteTooltip(emoteName, newState)
  if (opts?.skipSync && !opts?.silent) showToast(t('mc_emote_unblocked', [emoteName]), 'success')
  flashAllEmotes(emoteName, 'hs-flash-unblock')
  if (typeof invalidateRenderedForEmotes === 'function') invalidateRenderedForEmotes(emoteName)
}

// Add emote to inventory (click-to-add for unadded emotes).
// zeroWidth: optional — pass true for 7TV overlay emotes (wavE, SnowTime…) so
// the server persists the stack flag. Falsy default triggers a best-effort
// lookup across mcRemoteEmoteIndex + zeroWidthFromAnyCache so all callers
// (picker, chat-row click, auto-add-on-send, chip-paste) inherit the flag
// without each having to plumb it through their own state.
async function addEmoteToInventory(emoteName, emoteUrl, emoteSource, _targetEl, zeroWidth, silent) {
  if (!emoteName) return false
  if (zeroWidth == null) {
    const remote = mcRemoteEmoteIndex.get(emoteName)
    zeroWidth = !!(remote?.zeroWidth || zeroWidthFromAnyCache(emoteName))
  }
  // Guard: never persist a placeholder/data URI. A blocked emote renders with
  // a transparent px, and the click-to-readd path can hand us that src — adding
  // it would store a blank emote that renders empty forever (and the server
  // rejects non-https anyway). Reject early with a clear toast.
  if (!emoteUrl || !/^https?:\/\//i.test(emoteUrl)) {
    if (!silent) showToast(t('mc_emote_add_unavailable', [emoteName]), 'error')
    return false
  }
  let _added = false
  pendingEmoteOps.add(emoteName)
  try {
    // Generate a hash from the URL for the API
    const emoteHash = emoteUrl ? btoa(emoteUrl).slice(0, 32) : emoteName

    // Send to background script for API call with auth
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'add_to_inventory',
          emoteName: emoteName,
          emoteHash: emoteHash,
          emoteUrl: emoteUrl,
          zeroWidth: !!zeroWidth,
        },
        (resp) => {
          // Read lastError so Chrome doesn't log an "unchecked runtime.lastError"
          // warning on context invalidation / BG crash; treat as a failed add
          // (resp stays undefined → response?.success is falsy below).
          if (chrome.runtime.lastError) resolve(undefined)
          else resolve(resp)
        },
      )
    })

    if (response?.success) {
      _added = true
      // Update local cache - change from unadded to owned
      // Adding and blocking are mutually exclusive
      blockedEmoteNames.delete(emoteName)
      // No longer "removed" or blocked — drop the stale render fallback entries.
      if (removedEmoteFallback.delete(emoteName)) persistRemovedFallback()
      if (blockedEmoteFallback.delete(emoteName)) persistBlockedFallback()
      const serverHash = response.hash || emoteHash
      inventoryEmotes.add(emoteName)
      inventoryHashes.set(emoteName, serverHash)
      viewerPersonalEmotes.set(emoteName, {
        url: emoteUrl,
        source: emoteSource || 'heatsync',
        state: 'owned',
        hash: serverHash,
        slot: response.slot,
        zeroWidth: !!zeroWidth,
        addedAt: Date.now(),
      })
      if (emoteCache.has(emoteName)) {
        const cached = emoteCache.get(emoteName)
        cached.state = 'owned'
        if (!cached.hash) cached.hash = serverHash
      }
      // Update hash lookup maps (bounded to emoteCache size)
      emoteHashes.set(emoteName, serverHash)
      hashToName.set(serverHash, emoteName)
      while (emoteHashes.size > 2000) {
        emoteHashes.delete(emoteHashes.keys().next().value)
      }
      while (hashToName.size > 2000) {
        hashToName.delete(hashToName.keys().next().value)
      }

      // Update all wrappers in DOM (no full re-render)
      queryEmoteWrappers(emoteName).forEach((w) => {
        w.classList.remove('hs-state-global', 'hs-state-unadded', 'hs-state-blocked')
        w.classList.add('hs-state-owned')
        w.dataset.state = 'owned'
      })

      refreshEmoteTooltip(emoteName, 'owned')
      if (!silent) {
        showToast(t('mc_emote_added', [emoteName]), 'success')
        flashAllEmotes(emoteName, 'hs-flash-add')
      }
    } else if (!silent) {
      // Logged-out is the common case, not a failure — one gentle nudge
      // (statusbar dedupes to ×N) instead of a red per-emote error.
      const addErr = String(response?.error || '')
      if (/not logged in/i.test(addErr)) {
        showToast(t('mc_emote_add_login'), 'info')
      } else {
        showToast(addErr || t('mc_emote_add_failed', [emoteName]), 'error')
      }
    } else {
      log('Auto-add failed silently:', emoteName, response?.error || '(no error)')
    }
  } catch (e) {
    log('Add emote error:', e)
    if (!silent) showToast(t('mc_emote_add_error', [emoteName]), 'error')
  } finally {
    pendingEmoteOps.delete(emoteName)
  }
  return _added
}

// Sync block/unblock to heatsync.org API via background script, then RECONCILE.
// The background handler reports an HTTP failure by RESOLVING with
// {success:false} (not rejecting), so the old fire-and-forget `.catch()` never
// saw it: a 500 / rate-limit / expired-token block showed "blocked ✓", silently
// wasn't persisted, and reverted on the next inventory refetch with no signal.
// Now we await the outcome and, on a confirmed failure, roll the optimistic
// local change back (reverse op, skipSync so it doesn't re-write the server)
// and say so. On success we finally emit the toast the UI used to fire blind.
async function syncBlockToAPI(emoteName, block, ctx) {
  const silent = !!ctx?.silent
  let resp
  try {
    // Background script expects message.hash - use emoteHashes (most complete mapping)
    const hash =
      emoteHashes.get(emoteName) ||
      (lookupEmote(emoteName)?.url ? btoa(lookupEmote(emoteName).url).slice(0, 32) : emoteName)
    resp = await chrome.runtime.sendMessage({
      type: block ? 'block_emote' : 'unblock_emote',
      hash: hash,
      emoteName: emoteName,
    })
  } catch (e) {
    // A rejected sendMessage is almost always "extension context invalidated"
    // (reload/update) — treat it as a confirmed failure so we don't leave a
    // lie on screen, same as a {success:false} body.
    resp = { success: false, error: e?.message || 'context' }
  }
  if (resp && resp.success === false) {
    log('block sync rejected:', resp.error)
    // Roll back the optimistic local change. This is a rollback of a rollback-
    // free op, so pass skipSync (don't re-hit the server) + silent (the error
    // toast below is the only message this failure gets).
    if (block) unblockEmote(emoteName, { skipSync: true, silent: true })
    else blockEmote(emoteName, ctx?.url, ctx?.source, { skipSync: true, silent: true })
    if (!silent) showToast(t(block ? 'mc_emote_block_failed' : 'mc_emote_unblock_failed'), 'error')
    return
  }
  // Confirmed (or logged-out local success). Emit the success toast now.
  if (!silent) showToast(t(block ? 'mc_emote_blocked_toast' : 'mc_emote_unblocked', [emoteName]), 'success')
}

// Emote cache (loaded from storage)
// Format: Map<name, {url, source, state}>
// States: 'owned' (in inventory), 'global' (third-party), 'unadded' (heatsync, not owned)
const emoteCache = new Map() // Globals only — heatsync globals + 7TV globals + native Twitch (NO viewer inventory, NO channel)
const channelEmoteCaches = {} // Per-channel emotes: { channelName: Map<name, emoteData> }
const inventoryEmotes = new Set() // Names of emotes in user's inventory
// Viewer's personal set — separated from emoteCache so it does NOT bleed into
// OTHER users' rendered messages. Used as senderEmotes only when sender == viewer.
const viewerPersonalEmotes = new Map() // Map<name, emoteData>
// Emotes the viewer click-pasted from OTHER users' messages this session. NEVER
// rolled back (unlike the viewerPersonalEmotes optimistic seed): if the
// auto-add-on-send POST fails — offline, rate-limit, recycled SW, or composing
// from a kick/yt surface with an unreadable heatsync cookie — that seed is
// deleted and the own echo would textify with no fallback (the exact logged-out
// symptom). This map is the durable fallback: own-message render consults it so
// a click-pasted emote ALWAYS renders in your own echo. Keyed by ESCAPED name
// (matches processEmotes' escaped-token lookups). Own-messages only — never
// applied to other senders' rendering.
const clickPastedRefs = new Map() // Map<escapedName, {url, source, state, zeroWidth}>
const CLICK_PASTED_REFS_MAX = 300
function registerClickPastedRef(name, url, source, zeroWidth) {
  if (!name || !url || !/^https?:/i.test(url)) return
  const key = escapeHtml(name)
  clickPastedRefs.set(key, { url, source: source || 'heatsync', state: 'global', zeroWidth: !!zeroWidth })
  while (clickPastedRefs.size > CLICK_PASTED_REFS_MAX) {
    const oldest = clickPastedRefs.keys().next().value
    if (oldest === undefined) break
    clickPastedRefs.delete(oldest)
  }
}
// Render fallback for emotes the viewer REMOVED from their set. Removing purges
// the emote from inventory/caches, so after a refresh the viewer's own past
// messages that used it would resolve to nothing and render as raw text. This
// bounded, persisted map keeps the URL resolvable so those messages still draw
// the image (as unadded/orange — not owned). Gated to the viewer's own messages
// in processEmotes so it never bleeds into other senders' rendering.
const removedEmoteFallback = new Map() // Map<name, {url, source, zeroWidth}>
const REMOVED_FALLBACK_CAP = 1000
let _removedFallbackPersistTimer = null
function persistRemovedFallback() {
  if (_removedFallbackPersistTimer) return
  _removedFallbackPersistTimer = cleanup.setTimeout(() => {
    _removedFallbackPersistTimer = null
    const obj = {}
    for (const [name, e] of removedEmoteFallback) obj[name] = e
    try {
      chrome.storage.local.set({ hs_removed_emote_fallback: obj })
    } catch {}
  }, 1000)
}
function rememberRemovedEmote(name, url, source, zeroWidth) {
  if (!name || !url) return
  removedEmoteFallback.delete(name) // re-insert to refresh LRU position
  // removedAt: gate processEmotes so the fallback only fills in messages
  // that pre-date the removal (preserves past-history rendering, per intent).
  // Newly-sent own messages stay raw — removing means "I don't want this in
  // chat anymore", so a re-post shouldn't silently re-render the image.
  removedEmoteFallback.set(name, {
    url,
    source: source || 'heatsync',
    zeroWidth: !!zeroWidth,
    state: 'unadded',
    removedAt: Date.now(),
  })
  while (removedEmoteFallback.size > REMOVED_FALLBACK_CAP) {
    removedEmoteFallback.delete(removedEmoteFallback.keys().next().value)
  }
  persistRemovedFallback()
}

// Block-state render fallback. Blocking strips the emote from inventory/caches,
// and blockedEmoteNames is otherwise reconstructed from blockedEmoteHashes via
// hashToName — which can't recover a name after refresh when the emote is in no
// loaded cache (removed from set, foreign channel). The name is then unknown, so
// the blocked-box render branch never fires and the token leaks as raw text. This
// bounded, persisted map keeps the NAME (and url/source, for inline unblock-restore)
// so the 2px dashed box survives refresh. Mirror of removedEmoteFallback.
const blockedEmoteFallback = new Map() // Map<name, {url, source, zeroWidth}>
const BLOCKED_FALLBACK_CAP = 1000
let _blockedFallbackPersistTimer = null
function persistBlockedFallback() {
  if (_blockedFallbackPersistTimer) return
  _blockedFallbackPersistTimer = cleanup.setTimeout(() => {
    _blockedFallbackPersistTimer = null
    const obj = {}
    for (const [name, e] of blockedEmoteFallback) obj[name] = e
    try {
      chrome.storage.local.set({ hs_blocked_emote_fallback: obj })
    } catch {}
  }, 1000)
}
function rememberBlockedEmote(name, url, source, zeroWidth) {
  if (!name) return // url optional — a name with no resolvable url still needs the box
  blockedEmoteFallback.delete(name) // re-insert to refresh LRU position
  blockedEmoteFallback.set(name, { url: url || '', source: source || 'heatsync', zeroWidth: !!zeroWidth })
  while (blockedEmoteFallback.size > BLOCKED_FALLBACK_CAP) {
    blockedEmoteFallback.delete(blockedEmoteFallback.keys().next().value)
  }
  persistBlockedFallback()
}
// Viewer's per-channel Twitch IRC badges. Populated from USERSTATE messages
// (sent on JOIN + after every viewer PRIVMSG). Used to gate Twitch native
// sub-emote clicks: no `subscriber`/`founder` badge → render as locked.
// Map<channel, Set<badgeName>>.
const viewerBadgesPerChannel = new Map()
// Per-sender fetched 7TV/BTTV personal sets — write-once-per-(key, name), persistent across sessions.
// Map<"platform:platform_user_id", Map<name, emoteData>>. Empty inner Map = sender has no personal set (cached miss).
// Platform prefixes: "twitch:", "kick:", "ytc:" (youtube, keyed by UC… channel
// id — resolves the sender's own set even before twitch-link completes),
// "yt:" (display-name fallback, only when no channel id is known yet). A
// youtube sender uses "twitch:" instead of either once cross-platform link resolves.
// Loaded fully at boot from chrome.storage.local["sender_emote_sets"] BEFORE first render → survives hard refresh.
const senderEmoteSets = new Map()
// LRU cap. Was 5000 which dominated heap growth on xqc-tier channels
// (thousands of unique chatters firing per session × ~50-100 names each =
// hundreds of thousands of Map entries). 500 covers the realistic
// sender-set re-render window; evicted senders get re-fetched on next
// message (small API hit, big memory win). Heap growth on xqc dropped
// from ~14 MB/sec to a fraction of that.
const SENDER_EMOTE_LRU_MAX = 500
// Per-sender name cap — the outer LRU bounds sender COUNT but a single
// sender's inner Map was open-ended, the same one-level-down shape as the
// 5000-sender regression above. Real 7TV+BTTV personal sets top out around
// 100-150 names; 300 changes nothing for legit senders and bounds a
// malformed/hostile batch payload. Insert-order eviction: oldest-known name
// goes first, re-fetched on the sender's next message like outer eviction.
const SENDER_EMOTE_NAMES_MAX = 300
// Blobs persisted before the fetch path switched from merge to authoritative
// replace can carry names the sender never/no-longer owns (merge-era bleed) —
// loading them paints wrong emotes for a fetch round-trip on every boot.
// Bump to discard incompatible persisted data once; sets rebuild fresh.
const SENDER_EMOTE_SETS_VERSION = 2
// Clock-drift pad for the inventory-time render gate (_sGate): a message's
// platform timestamp (tmi-sent-ts / kick / yt) and the server's added_at come
// from different clocks. Without the pad, collect-then-send-within-seconds
// could gate the sender's OWN first use off. Retro-flips this is meant to stop
// are minutes-to-days old, so 2min of slack costs nothing.
const EMOTE_ADDED_SKEW_MS = 120000
let _senderEmotePersistTimer = null
let _senderEmoteDirty = false

function _scheduleSenderEmotePersist() {
  if (_senderEmotePersistTimer || !_senderEmoteDirty) return
  // Was 500ms debounce — on busy channels this fired 2× per second, each
  // serializing the whole 500-entry Map to JSON + storage write (~30-100ms
  // of main-thread work each). Now 4000ms: still catches a session's worth
  // of additions on tab close, doesn't spam during heavy chat. Persist also
  // runs on visibilitychange below so unsynced state is flushed when the
  // user navigates away.
  _senderEmotePersistTimer = cleanup.setTimeout(() => {
    _senderEmotePersistTimer = null
    if (!_senderEmoteDirty) return
    _senderEmoteDirty = false
    // Build the persist payload inside requestIdleCallback so the JSON
    // serialization + storage write don't compete with chat render frames.
    const writeIt = () => {
      const out = {}
      for (const [k, m] of senderEmoteSets) {
        out[k] = Object.fromEntries(m)
      }
      try {
        chrome.storage.local.set({ sender_emote_sets: out, sender_emote_sets_v: SENDER_EMOTE_SETS_VERSION })
      } catch {}
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(writeIt, { timeout: 5000 })
    } else {
      writeIt()
    }
  }, 4000)
}

// Keep the EARLIEST known ownership start when a fresh fetch updates an entry.
// A re-collected emote gets a NEW server added_at; taking it verbatim would
// gate off (retro-textify) rows rendered under the original interval —
// "rendered forever" wins, so the earliest start is preserved. The fresh data
// carries no removedAt (the sender owns it NOW), which correctly clears any
// tombstone left by a broadcast removal.
function _carryEmoteInterval(prev, data) {
  if (prev?.addedAt && data?.addedAt && prev.addedAt < data.addedAt) {
    return { ...data, addedAt: prev.addedAt }
  }
  return data
}

// Merge a sender's fetched set, UPDATING entries whose url/state/source changed
// (a re-fetch picks up emotes the sender added AND state/label corrections). Names
// absent from a fetch are kept — an empty/partial fetch never wipes known emotes.
// The set keeps rendering throughout; only changed names trigger a re-render.
function mergeSenderEmotes(senderKey, nameToEmote) {
  if (!senderKey) return false
  let inner = senderEmoteSets.get(senderKey)
  if (!inner) {
    inner = new Map()
    senderEmoteSets.set(senderKey, inner)
    // LRU evict oldest senders if over cap (preserves all names per kept sender)
    if (senderEmoteSets.size > SENDER_EMOTE_LRU_MAX) {
      senderEmoteSets.delete(senderEmoteSets.keys().next().value)
    }
  } else {
    // Re-insert to bump LRU recency
    senderEmoteSets.delete(senderKey)
    senderEmoteSets.set(senderKey, inner)
  }
  let changed = false
  if (nameToEmote) {
    for (const [name, data] of Object.entries(nameToEmote)) {
      const prev = inner.get(name)
      if (
        !prev ||
        prev.url !== data.url ||
        prev.state !== data.state ||
        prev.source !== data.source ||
        prev.addedAt !== data.addedAt ||
        prev.removedAt !== data.removedAt
      ) {
        inner.set(name, _carryEmoteInterval(prev, data))
        changed = true
        if (inner.size > SENDER_EMOTE_NAMES_MAX) inner.delete(inner.keys().next().value)
      }
    }
  }
  if (changed) {
    _senderEmoteDirty = true
    _scheduleSenderEmotePersist()
  }
  return changed
}

function getSenderEmotes(senderKey) {
  return senderKey ? senderEmoteSets.get(senderKey) : undefined
}

// Tombstone an emote NAME in every cached sender set. Called when a WS
// emote:removed broadcast arrives — the actor's user_emote_set on the server
// dropped the name. Stamping removedAt (instead of deleting) closes the
// ownership interval: rows sent BEFORE the removal keep rendering forever
// (_sGate), rows sent after stay text. Match by name is fine: a sender can
// only have one emote per name, so tombstoning by name targets the right
// entry without needing the actor's twitch ID. Innocent senders who own a
// same-named emote get tombstoned too — the freshness bust in the broadcast
// handler refetches them and the fresh entry (no removedAt) clears it.
function dropEmoteFromAllSenders(emoteName) {
  if (!emoteName) return false
  let changed = false
  const now = Date.now()
  for (const [, set] of senderEmoteSets) {
    const e = set?.get?.(emoteName)
    if (e && !e.removedAt) {
      e.removedAt = now
      changed = true
    }
  }
  if (changed) {
    _senderEmoteDirty = true
    _scheduleSenderEmotePersist()
  }
  return changed
}

// Precise sibling: drop a name from ONLY the given sender keys (a live push
// carries the exact keys the sender resolves as). No innocent same-named
// emote on another sender gets stripped, so no compensating global
// freshness-bust is needed afterward.
function dropEmoteFromSenders(senderKeys, emoteName) {
  if (!emoteName || !Array.isArray(senderKeys)) return false
  let changed = false
  for (const key of senderKeys) {
    if (senderEmoteSets.get(key)?.delete?.(emoteName)) changed = true
  }
  if (changed) {
    _senderEmoteDirty = true
    _scheduleSenderEmotePersist()
  }
  return changed
}

// Replace a sender's set with an AUTHORITATIVE fresh fetch — drops any
// cached names absent from the new data. Use ONLY when the response is
// known good (HTTP 200, not a transient error). mergeSenderEmotes is the
// additive sibling for cases where we don't trust empty responses.
// Returns { changed, dropped } — dropped means a cached name was REMOVED,
// i.e. an already-painted row may be showing an emote the sender no longer
// owns and needs an immediate (not debounced) downgrade to text.
function replaceSenderEmotes(senderKey, nameToEmote) {
  if (!senderKey) return { changed: false, dropped: false }
  const fresh = nameToEmote || {}
  let inner = senderEmoteSets.get(senderKey)
  if (!inner) {
    // First time we see this sender — same path as merge, but tracked.
    inner = new Map()
    senderEmoteSets.set(senderKey, inner)
    if (senderEmoteSets.size > SENDER_EMOTE_LRU_MAX) {
      senderEmoteSets.delete(senderEmoteSets.keys().next().value)
    }
  } else {
    senderEmoteSets.delete(senderKey)
    senderEmoteSets.set(senderKey, inner)
  }
  let changed = false
  let dropped = false
  // Names absent from the authoritative fetch: entries with an inventory
  // stamp (addedAt) were CONFIRMED owned earlier, so close their interval
  // with a tombstone instead of deleting — rows rendered while owned keep
  // rendering forever (_sGate), future rows fall to text. Unstamped entries
  // (7TV/BTTV set churn, pre-stamp caches) keep the old delete semantics.
  // Existing tombstones pass through untouched. `dropped` stays true either
  // way — callers use it to trigger the immediate re-render, and the gate
  // decides per-row from there.
  for (const name of [...inner.keys()]) {
    if (!(name in fresh)) {
      const prev = inner.get(name)
      if (prev?.removedAt) continue
      if (prev?.addedAt) {
        prev.removedAt = Date.now()
      } else {
        inner.delete(name)
      }
      changed = true
      dropped = true
    }
  }
  // Add/update fresh names
  for (const [name, data] of Object.entries(fresh)) {
    // Validate cross-user emote urls before caching. These come from other
    // viewers' sets (public /api/users/emotes/batch) and are otherwise only
    // escapeHtml'd at render — never scheme-checked. Reject non-http(s) so a
    // crafted javascript:/data:/blob: url can't become an <img src> beacon or
    // feed the data-emote-url window.open sink on every viewer who renders it.
    if (data?.url) {
      let u = String(data.url)
      if (u.startsWith('//')) u = `https:${u}`
      if (!safeUrl(u)) {
        if (inner.delete(name)) {
          changed = true
          dropped = true
        }
        continue
      }
    }
    const prev = inner.get(name)
    if (
      !prev ||
      prev.url !== data.url ||
      prev.state !== data.state ||
      prev.source !== data.source ||
      prev.cw !== data.cw ||
      prev.addedAt !== data.addedAt ||
      prev.removedAt !== data.removedAt
    ) {
      inner.set(name, _carryEmoteInterval(prev, data))
      changed = true
      if (inner.size > SENDER_EMOTE_NAMES_MAX) inner.delete(inner.keys().next().value)
    }
  }
  if (changed) {
    _senderEmoteDirty = true
    _scheduleSenderEmotePersist()
  }
  return { changed, dropped }
}

async function loadSenderEmoteSets() {
  try {
    const stored = await chrome.storage.local.get(['sender_emote_sets', 'sender_emote_sets_v'])
    senderEmoteSets.clear()
    // Version gate — see SENDER_EMOTE_SETS_VERSION. A mismatched blob is
    // discarded rather than rendered-then-corrected.
    if (stored.sender_emote_sets && stored.sender_emote_sets_v !== SENDER_EMOTE_SETS_VERSION) {
      try {
        chrome.storage.local.remove(['sender_emote_sets'])
      } catch {}
      log('Discarded sender_emote_sets: version', stored.sender_emote_sets_v, '!=', SENDER_EMOTE_SETS_VERSION)
      return
    }
    // Load the persisted cache so senders render IMMEDIATELY on boot. Staleness
    // is handled non-destructively: the in-memory freshness map is empty after a
    // reload, so every sender is re-fetched once this session, and mergeSenderEmotes
    // UPDATES changed entries in place (no discard → no text gap while refreshing).
    //
    // CAP THE LOAD: prior versions persisted up to ~5000 senders. Loading all
    // of them brought the in-memory map to its old size at boot, eating 100s
    // of MB before any chat fired. Cap to LRU_MAX. Truncation keeps the LAST
    // (most-recent) entries since Object.entries preserves insertion order
    // and the persist also writes in insertion order.
    const obj = stored.sender_emote_sets || {}
    const entries = Object.entries(obj)
    const truncated = entries.length > SENDER_EMOTE_LRU_MAX ? entries.slice(-SENDER_EMOTE_LRU_MAX) : entries
    for (const [k, names] of truncated) {
      if (!names || typeof names !== 'object') continue
      senderEmoteSets.set(k, new Map(Object.entries(names)))
    }
    if (entries.length > SENDER_EMOTE_LRU_MAX) {
      log('Loaded sender_emote_sets:', senderEmoteSets.size, 'of', entries.length, 'persisted (truncated to LRU cap)')
      // Persist the truncation back so the storage shrinks too.
      _senderEmoteDirty = true
      _scheduleSenderEmotePersist()
    } else {
      log('Loaded sender_emote_sets:', senderEmoteSets.size, 'senders')
    }
  } catch (e) {
    log('Error loading sender_emote_sets:', e)
  }
}

// Channel-emote pools for the ACTIVE TAB. Pools are keyed by the FETCHED
// owner name (e.g. 'nl_kripp'), but a merged-identity tab's id is the
// heatsync handle (e.g. 'kripparrian') and on yt pages currentTab/currentChannel
// are a videoId/@handle — none of which are pool keys. Every currentTab-keyed
// lookup (picker grid, input preview chip, tab-complete, hover) silently lost
// the ENTIRE channel set on those tabs (kripp's 1051-emote pool sat unused
// under 'nl_kripp' while the chain probed 'kripparrian'). Resolve the tab's
// twitch/kick slot names + yt handle as pool keys, deduped, empties skipped.
function activeTabEmotePools() {
  const pools = []
  const seen = new Set()
  const push = (k) => {
    if (!k) return
    const m = channelEmoteCaches[k] || channelEmoteCaches[String(k).toLowerCase()]
    if (m?.size && !seen.has(m)) {
      seen.add(m)
      pools.push(m)
    }
  }
  push(currentTab)
  const ch = typeof getChannelById === 'function' ? getChannelById(currentTab) : null
  push(ch?.twitch)
  push(ch?.kick)
  const ytHandle = typeof ch?.youtube === 'string' ? ch.youtube.match(/\/@([^/?]+)/)?.[1] : null
  if (ytHandle) {
    push(`@${ytHandle}`)
    push(ytHandle)
  }
  push(typeof getLiveChannel === 'function' ? getLiveChannel() : null)
  push(typeof getCurrentChannel === 'function' ? getCurrentChannel() : null)
  return pools
}
function activeTabChannelEmote(name) {
  for (const m of activeTabEmotePools()) {
    const hit = m.get(name)
    if (hit) return hit
  }
  return undefined
}

// Look up emote — viewer-perspective fallback chain (used by picker, hover preview, etc.)
function lookupEmote(name) {
  // removed/blocked fallbacks last: keep a removed-or-blocked emote's URL
  // resolvable so unblock + re-add (and re-renders) draw the real image and
  // never re-add the transparent placeholder a blocked render shows.
  return (
    viewerPersonalEmotes.get(name) ||
    emoteCache.get(name) ||
    activeTabChannelEmote(name) ||
    removedEmoteFallback.get(name) ||
    blockedEmoteFallback.get(name)
  )
}
// Kick-native emotes only exist on the wire as [emote:<id>:<name>]. Sending
// the bare name posts literal text to every kick client — and our own renderer
// paints bare names, so in-panel it looked right while nobody else saw the
// emote at all. Proven on 2026-07-21: a pool emote sent from the composer
// archived as the plain word, no emote ref. Rewrite kick-source words on the
// way out; twitch and youtube keep the bare word (their wire formats differ).
const KICK_EMOTE_ID_RE = /files\.kick\.com\/emotes\/(\d+)\//
const KICK_MAX_MESSAGE = 500
function kickifyEmoteText(text) {
  if (!text || typeof text !== 'string') return text
  const out = text.replace(/\S+/g, (word) => {
    // Never touch a token the user (or kick's own composer) already wrote.
    if (word.startsWith('[emote:')) return word
    const e = typeof lookupEmoteRenderOrder === 'function' ? lookupEmoteRenderOrder(word) : null
    if (e?.source !== 'kick' || !e.url) return word
    const m = KICK_EMOTE_ID_RE.exec(e.url)
    return m ? `[emote:${m[1]}:${word}]` : word
  })
  // Tokens are far longer than the names they replace. If expanding pushed a
  // message that would have fit over kick's limit, send the words — a
  // delivered message without emote images beats a rejected one.
  if (out.length > KICK_MAX_MESSAGE && text.length <= KICK_MAX_MESSAGE) return text
  return out
}

// In-set lookup: only emotes the viewer actually owns (heatsync inventory +
// their native Twitch subs). Excludes channel/global/3rd-party pools — those
// are words a viewer never deliberately added (e.g. a channel's lowercase
// "what" 7TV emote), so silently imagifying them mid-sentence is hostile.
function lookupOwnedEmote(name) {
  return viewerPersonalEmotes.get(name)
}
// Render-order resolution for the INPUT PREVIEW: channel > inventory > global,
// mirroring processEmotes (channel emotes authoritative in their own channel).
// lookupEmote stays inventory-first — it drives block/add/state/tooltip, which
// are viewer-centric. The input chip must match what gets RENDERED on send, so
// it resolves channel-first here. Removed/blocked fallbacks stay last so a
// blocked emote still resolves its real url for the dashed-box preview.
function lookupEmoteRenderOrder(name) {
  return (
    activeTabChannelEmote(name) ||
    viewerPersonalEmotes.get(name) ||
    emoteCache.get(name) ||
    removedEmoteFallback.get(name) ||
    blockedEmoteFallback.get(name)
  )
}
// True if ANY cache knows this emote name is 7TV zero-width. The owned set
// (viewerPersonalEmotes) and the heatsync server cache don't carry 7TV's
// zeroWidth flag, and viewerPersonalEmotes is resolved FIRST — so an overlay
// emote you OWN (e.g. "Wave") otherwise resolves zeroWidth:false and renders
// inline. The channel/global caches fetch the flag straight from 7TV, so
// consult them to recover it.
function zeroWidthFromAnyCache(name) {
  // Caches are keyed by RAW names; callers may pass an HTML-escaped chat token
  // (`&gt;:3`). Unescape so specials resolve. Identity for names without `&`.
  const raw = name.indexOf('&') === -1 ? name : unescapeHtml(name)
  if (emoteCache.get(raw)?.zeroWidth) return true
  // for-in over the live object instead of Object.values() — this runs once
  // per rendered emote whose own zeroWidth flag is falsy (nearly all of
  // them), and a fresh array allocation on every call was pure per-render
  // churn. for-in reads channelEmoteCaches directly (no snapshot to go
  // stale), so a newly-loaded channel cache is always seen immediately.
  for (const k in channelEmoteCaches) {
    const m = channelEmoteCaches[k]
    if (m && typeof m.get === 'function' && m.get(raw)?.zeroWidth) return true
  }
  return false
}
// Provider asset id parsed from a CDN url — the emote's identity across size
// variants (1x/2x) and formats (.avif/.webp). Null for non-provider urls.
function _hsEmoteAssetId(url) {
  if (!url) return null
  const m = /(?:cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com)\/emote\/([^/]+)/.exec(url)
  return m ? m[1] : null
}
// Identity-checked zero-width recovery for a PICKED emote (name + url): true
// only when a cache entry under this name carries zeroWidth AND is the same
// provider asset as the pick. Owned/inventory copies have 7TV's zeroWidth flag
// stripped (see zeroWidthFromAnyCache) — same asset id proves the flagged
// channel/global entry IS the picked emote, so the flag is recoverable. A
// same-NAME different-ASSET entry is a collision and must not stack the pick
// onto the preceding chip.
function zeroWidthForSameAsset(name, url) {
  const id = _hsEmoteAssetId(url)
  if (!id) return false
  const check = (e) => !!(e?.zeroWidth && _hsEmoteAssetId(e.url) === id)
  // Own set too: auto-add-on-send and the picker DO stamp zeroWidth on
  // viewerPersonalEmotes entries, so an inventory-only overlay (added via 7TV
  // search, absent from the current channel's caches) still recovers.
  if (check(viewerPersonalEmotes.get(name))) return true
  if (check(emoteCache.get(name))) return true
  for (const k in channelEmoteCaches) {
    const m = channelEmoteCaches[k]
    if (m && typeof m.get === 'function' && check(m.get(name))) return true
  }
  return false
}
// Resolve a typed emote name to {emote, isOverlay, displayName}.
// Handles zeroWidth flag AND the 7TV-style "name0" overlay convention
// ("TriHard0" → looks up "TriHard" and treats as overlay) so the input
// preview matches how the chat renderer resolves the same word.
// ownedOnly restricts resolution to the viewer's own set — used by the LIVE
// type-word-then-space auto-convert so only your emotes imagify as you type.
// Channel/global emotes still render via Tab-complete (which omits the flag).
function lookupEmoteWithOverlay(name, { ownedOnly = false } = {}) {
  const resolve = ownedOnly ? lookupOwnedEmote : lookupEmoteRenderOrder
  const endsWithZero = name.length > 1 && name.endsWith('0')
  // A literal full-name hit ALWAYS wins — an emote actually named "lerolero0"
  // is a standalone emote, NOT the "lerolero" overlay. It only stacks if it
  // carries a real zeroWidth flag (recoverable from any cache for owned
  // copies that shadow the flagged channel/global entry). The trailing-0
  // heuristic must never shadow a real "name0" emote. See processEmotes for
  // the matching chat-render order.
  const emote = resolve(name)
  if (emote) {
    let isOverlay = !!emote.zeroWidth
    if (!isOverlay && zeroWidthFromAnyCache(name)) isOverlay = true
    return { emote, isOverlay, displayName: name }
  }
  // No literal hit — apply the 7TV-style "name0" overlay convention: strip the
  // trailing 0 and overlay the base emote (e.g. "TriHard0" → overlay TriHard).
  if (endsWithZero) {
    const baseEmote = resolve(name.slice(0, -1))
    if (baseEmote) return { emote: baseEmote, isOverlay: true, displayName: name }
  }
  return null
}
const inventoryHashes = new Map() // name → hash for remove_from_inventory
const emoteHashes = new Map() // name → hash for ALL emotes (block/unblock API)
const hashToName = new Map() // hash → name (reverse lookup for loading blocked from storage)

// Detect emote source from URL
function detectEmoteSource(url, hint = null) {
  if (!url) return hint || 'unknown'
  if (url.includes('cdn.7tv.app')) return '7tv'
  if (url.includes('cdn.betterttv.net')) return 'bttv'
  if (url.includes('cdn.frankerfacez.com')) return 'ffz'
  if (url.includes('static-cdn.jtvnw.net')) return 'twitch'
  if (url.includes('kick.com') || url.includes('kick-static')) return 'kick'
  if (url.includes('heatsync.org')) return 'heatsync'
  return hint || 'unknown'
}

// Oversized BTTV emotes — BTTV declares per-emote 1x height and native BTTV
// renders taller-than-baseline emotes (NaM = 40px vs the 28px baseline) at
// their true height. The BG stamps `os` (height/28, >1 only) on entries whose
// fetch saw the height. Registry keyed by BTTV CDN id so copies of the same
// emote arriving WITHOUT dimensions (heatsync-inventory adds, sender personal
// sets) still resolve — the id in the url is the identity.
const _hsBttvOversize = new Map() // bttv emote id → height/28 ratio (>1 only)
function _hsBttvId(url) {
  const m = /cdn\.betterttv\.net\/emote\/([^/]+)\//.exec(url || '')
  return m ? m[1] : null
}
function _hsRegisterOversize(e) {
  if (!(e?.os > 1)) return
  const id = _hsBttvId(e.url)
  if (id) _hsBttvOversize.set(id, e.os)
}
// Ratio for a pool entry (0 = normal). Falls back to the registry by CDN id,
// and registers entries that carry their own os so later id-only copies hit.
function _hsEmoteOversize(entry) {
  if (!entry) return 0
  if (entry.os > 1) {
    _hsRegisterOversize(entry)
    return entry.os
  }
  const id = _hsBttvId(entry.url)
  return (id && _hsBttvOversize.get(id)) || 0
}

// Determine emote state: owned > global > unadded
function getEmoteState(name, source) {
  if (inventoryEmotes.has(name)) return 'owned'
  // Third-party emotes are always "global" (can't add to heatsync inventory)
  if (['7tv', 'bttv', 'ffz', 'twitch', 'kick'].includes(source)) return 'global'
  // Heatsync emotes not in inventory are "unadded"
  return 'unadded'
}

// Build a single channel's emote cache from a flat emotes array. Shared
// between loadEmotes (cold-start from storage) and the live broadcast handler
// in main.js so a channel_emotes_update lands directly in channelEmoteCaches
// — no waiting on the BG storage.set, no race where a partial broadcast
// triggers loadEmotes against still-stale storage.
function _buildChannelEmoteCache(ch, emotes, platform) {
  if (!ch || !Array.isArray(emotes)) return
  platform = platform || 'twitch'
  // Merge per-platform, keyed by the BARE channel name (every consumer —
  // render/picker/autocomplete — reads bare). A same-name twitch+kick
  // simulcast linked in one panel channel must keep BOTH sets: we replace
  // only THIS platform's prior contribution (tagged via _plat) so an update
  // refreshes without accumulating stale, and the other platform's emotes
  // survive instead of being overwritten. Same-name/different-image across
  // platforms falls to last-writer-wins (rare + cosmetic).
  let chCache = channelEmoteCaches[ch]
  if (!(chCache instanceof Map)) {
    chCache = new Map()
    channelEmoteCaches[ch] = chCache
  }
  for (const [name, e] of chCache) {
    if (e._plat === platform) chCache.delete(name)
  }
  for (const e of emotes) {
    if (!e.name || !e.url) continue
    if (
      e.source === 'twitch' &&
      (e.tier || e.emote_type === 'subscriptions' || e.emote_type === 'follower' || e.emote_type === 'bitstier')
    )
      continue
    // Same gating for Kick: subscribers_only emotes can't be sent/rendered by
    // non-subs, so they're excluded from the usable pool exactly like
    // tier-gated Twitch emotes above (no per-viewer sub-status to check here).
    if (e.source === 'kick' && e.subscribersOnly) continue
    const source = e.source || detectEmoteSource(e.url, '7tv')
    const state = inventoryEmotes.has(e.name) ? 'owned' : 'channel'
    _hsRegisterOversize(e)
    // Channel 7TV sets are fetched raw from 7tv.io (not the heatsync server's
    // filtered /api/emotes), so they carry the 7TV flags bitmask instead of a
    // pre-computed nsfw bool. Bit 16 (65536) = EmoteFlagsContentSexual — carry
    // it through so render can hide it per the viewer's own setting (see
    // hsChannelNsfwHidden in processEmotes).
    const entry = {
      url: e.url,
      source,
      state,
      zeroWidth: !!e.zeroWidth,
      os: e.os,
      _plat: platform,
      nsfw: !!(e.flags & 65536),
    }
    // Same-name collision between two third-party providers (7tv/bttv/ffz):
    // emoteProviderPriority decides the winner instead of plain array-order
    // last-write-wins. Every other pairing (heatsync, twitch, kick, or a
    // same-provider refresh) is untouched — see resolveEmoteProviderWinner.
    chCache.set(e.name, resolveEmoteProviderWinner(chCache.get(e.name), entry, emoteProviderPriority))
    if (e.hash) {
      emoteHashes.set(e.name, e.hash)
      hashToName.set(e.hash, e.name)
    }
  }
  // Ceiling on the per-channel map — every other cache in this file has one,
  // this (the authoritative path) trusted upstream response size. Real
  // channels combine to a few hundred names; 2000 only ever bites a
  // malformed/hostile payload. Oldest-inserted evicts first.
  while (chCache.size > 2000) chCache.delete(chCache.keys().next().value)
  // Self-heal the stale-emote ghost registry: any name back in this channel's
  // live set was re-added (perhaps while we missed the event) — drop it so old
  // messages stop rendering ghosted. The render path also guards on the live
  // set, so this is housekeeping, but it keeps the registry honest.
  try {
    const sreg = window._hsStaleEmotes
    const sm = sreg?.get((ch || '').toLowerCase())
    if (sm) {
      for (const name of [...sm.keys()]) {
        if (chCache.has(name)) sm.delete(name)
      }
      if (sm.size === 0) sreg.delete((ch || '').toLowerCase())
    }
  } catch (_) {}
  const keys = Object.keys(channelEmoteCaches)
  if (keys.length > 20) {
    for (const old of keys.slice(0, keys.length - 20)) {
      if (old !== ch) delete channelEmoteCaches[old]
    }
  }
}

let _loadEmotesInFlight = false
let _loadEmotesRerun = false
async function loadEmotes() {
  // Concurrency guard: the storage read is async (100–500ms on a cold SW). Two
  // overlapping calls would each clear viewerPersonalEmotes mid-populate, wiping
  // the other's partial state → messages render with no personal emotes. Serialize;
  // if events arrived during a run, rerun once to pick up the latest storage.
  if (_loadEmotesInFlight) {
    _loadEmotesRerun = true
    return
  }
  _loadEmotesInFlight = true
  try {
    try {
      const stored = await chrome.storage.local.get([
        'global_emotes',
        'emote_inventory',
        'channel_emotes_map',
        'native_twitch_emotes',
        'hs_removed_emote_fallback',
        'hs_blocked_emote_fallback',
      ])
      // Restore removed-emote render fallback (persists across refresh).
      removedEmoteFallback.clear()
      const rf = stored.hs_removed_emote_fallback
      if (rf && typeof rf === 'object') {
        for (const [name, e] of Object.entries(rf)) {
          if (e?.url)
            removedEmoteFallback.set(name, {
              url: e.url,
              source: e.source || 'heatsync',
              zeroWidth: !!e.zeroWidth,
              state: 'unadded',
              removedAt: Number(e.removedAt) || 0,
            })
        }
      }
      // Restore block-state render fallback so the dashed box survives refresh
      // (rebuildBlockedNames at the tail of this fn seeds blockedEmoteNames from it).
      blockedEmoteFallback.clear()
      const bf = stored.hs_blocked_emote_fallback
      if (bf && typeof bf === 'object') {
        for (const [name, e] of Object.entries(bf)) {
          if (e)
            blockedEmoteFallback.set(name, {
              url: e.url || '',
              source: e.source || 'heatsync',
              zeroWidth: !!e.zeroWidth,
            })
        }
      }
      emoteCache.clear()
      // Don't wipe channelEmoteCaches — live broadcasts may have direct-
      // populated a channel that storage hasn't persisted yet (BG writes
      // storage AFTER the final broadcast). Wiping would clobber it; the
      // loop below refreshes each channel that storage knows about.
      // Preserve in-flight optimistic preregister entries (autoAddInputEmotes
      // sets viewerPersonalEmotes BEFORE the server add resolves so the IRC
      // echo of "wavE" renders the image, not the bare word). Without this
      // snapshot, an unrelated storage change (channel emote refresh, global
      // update) racing the add wipes the optimistic entry before the echo
      // arrives → message renders as plain text. pendingEmoteOps tracks names
      // whose addEmoteToInventory is still in flight; restored at the bottom.
      const _inflight = new Map()
      for (const name of pendingEmoteOps) {
        const e = viewerPersonalEmotes.get(name)
        if (e) _inflight.set(name, e)
      }
      inventoryEmotes.clear()
      viewerPersonalEmotes.clear()
      inventoryHashes.clear()
      emoteHashes.clear()
      hashToName.clear()

      // Helper to register hash<->name mapping
      const registerHash = (name, hash) => {
        if (name && hash) {
          emoteHashes.set(name, hash)
          hashToName.set(hash, name)
        }
      }

      // First, build inventory set (emotes user owns)
      ;(stored.emote_inventory || []).forEach((e) => {
        if (e.name) {
          inventoryEmotes.add(e.name)
          if (e.hash) {
            inventoryHashes.set(e.name, e.hash)
            registerHash(e.name, e.hash)
          }
        }
      })

      // Add global emotes (heatsync globals - may or may not be in inventory)
      ;(stored.global_emotes || []).forEach((e) => {
        if (e.name && e.url) {
          const source = e.source || detectEmoteSource(e.url, 'heatsync')
          const state = getEmoteState(e.name, source)
          _hsRegisterOversize(e)
          const entry = { url: e.url, source, state, zeroWidth: !!e.zeroWidth, nsfw: !!e.nsfw, os: e.os }
          // See _buildChannelEmoteCache — same 7tv/bttv/ffz collision rule
          // applied to the global-tier pool.
          emoteCache.set(e.name, resolveEmoteProviderWinner(emoteCache.get(e.name), entry, emoteProviderPriority))
          while (emoteCache.size > 2000) {
            emoteCache.delete(emoteCache.keys().next().value)
          }
          if (e.hash) registerHash(e.name, e.hash)
        }
      })

      // Add inventory emotes (definitely owned) → viewerPersonalEmotes ONLY.
      // Keeping these out of emoteCache (the global fallback) is what prevents
      // viewer's personal '67' from bleeding into other users' messages.
      // Render path passes viewerPersonalEmotes as senderEmotes for own outgoing,
      // and lookupEmote() composes both for picker/hover/UI use cases.
      ;(stored.emote_inventory || []).forEach((e) => {
        if (e.name && e.url) {
          const source = e.source || 'heatsync'
          // server returns zero_width (snake_case from postgres column), older
          // payloads may carry zeroWidth — accept either; falsy default is fine.
          viewerPersonalEmotes.set(e.name, {
            url: e.url,
            source,
            state: 'owned',
            zeroWidth: !!(e.zero_width ?? e.zeroWidth),
            subscription: !!e.subscription,
            slot: e.slot,
            nsfw: !!e.nsfw,
            // BG-normalized epoch ms (emoteAddedAtMs) — inventory-time render gate
            addedAt: e.addedAt || 0,
            // server CW annotation — own msgs hide these at render when the
            // owner's own viewer_show_* toggles say so (picker unaffected)
            cwCats: Array.isArray(e.cw_cats) && e.cw_cats.length ? e.cw_cats : null,
          })
        }
      })

      // Load per-channel emotes into separate caches (prevents cross-channel leaking)
      const map = stored.channel_emotes_map || {}
      for (const [k, emotes] of Object.entries(map)) {
        if (!Array.isArray(emotes)) continue // skip 'loading' sentinels
        // Keys are "platform/channel" — split so the cache merges both platforms'
        // sets under the bare channel name (per-platform tagged, no overwrite).
        const slash = k.indexOf('/')
        const platform = slash >= 0 ? k.slice(0, slash) : 'twitch'
        const bare = slash >= 0 ? k.slice(slash + 1) : k
        _buildChannelEmoteCache(bare, emotes, platform)
      }
      // Native Twitch emotes — sub emotes carry e.owner (broadcaster login),
      // true Twitch globals do not. Globals → emoteCache (everyone can render them).
      // Subs → viewerPersonalEmotes: same gate as heatsync inventory — surfaced
      // for picker/autocomplete/own outgoing, kept out of the global render
      // fallback so they don't bleed into other senders' messages.
      ;(stored.native_twitch_emotes || []).forEach((e) => {
        if (!e.name || !e.url) return
        const isSub = !!e.owner
        if (isSub) {
          if (!viewerPersonalEmotes.has(e.name)) {
            viewerPersonalEmotes.set(e.name, {
              url: e.url,
              source: 'twitch',
              state: 'owned',
              subscription: true,
              owner: e.owner,
            })
            if (e.hash) registerHash(e.name, e.hash)
          }
          return
        }
        if (emoteCache.has(e.name)) return
        emoteCache.set(e.name, { url: e.url, source: 'twitch', state: 'global' })
        while (emoteCache.size > 2000) {
          emoteCache.delete(emoteCache.keys().next().value)
        }
        if (e.hash) registerHash(e.name, e.hash)
      })

      // Restore in-flight optimistic preregister entries that the clear()
      // above wiped — server hasn't confirmed yet, so they're not in stored.
      // Without this, the IRC echo of an auto-add emote misses the lookup
      // and the message renders as plain text instead of the image.
      for (const [name, e] of _inflight) {
        if (!viewerPersonalEmotes.has(name)) viewerPersonalEmotes.set(name, e)
      }

      // Rebuild blockedEmoteNames from loaded hashes
      rebuildBlockedNames()

      log('Loaded', emoteCache.size, 'emotes (inventory:', inventoryEmotes.size, ', hashes:', emoteHashes.size, ')')
    } catch (e) {
      log('Error loading emotes:', e)
    }

    // Also scan DOM for third-party emotes (BTTV, FFZ, 7TV)
    scanDomForEmotes()

    // Picker DOM is now stale — schedule an idle prebuild so the very first
    // click after page load opens the picker instantly (no parse on click).
    markPickerDirty()
    prebuildPickerIdle()
  } finally {
    _loadEmotesInFlight = false
    if (_loadEmotesRerun) {
      _loadEmotesRerun = false
      loadEmotes()
    }
  }
}

// Scan DOM for emotes rendered in chat — route to the current channel's cache, not global
function scanDomForEmotes() {
  const ch = getCurrentChannel()
  if (!ch) return

  // Ensure channel cache exists
  if (!channelEmoteCaches[ch]) channelEmoteCaches[ch] = new Map()
  // Evict oldest if exceeds 20
  const chKeys = Object.keys(channelEmoteCaches)
  if (chKeys.length > 20) {
    // never evict the active channel — deleting it then reading cache.size below throws
    const old = chKeys[0]
    if (old !== ch) delete channelEmoteCaches[old]
  }
  const cache = channelEmoteCaches[ch]

  // Cap per-channel to prevent unbounded growth. 2300 = the authoritative
  // path's 2000 ceiling + scan allowance; the old 5000 was a 25MB phantom
  // worst-case across 20 channels for a path that only ever adds
  // heatsync/unknown stragglers (twitch + 7tv/bttv/ffz excluded below).
  if (cache.size >= 2300) return

  // Single combined selector — one DOM scan instead of 7 separate querySelectorAll calls
  const combinedSelector =
    '.chat-line__message img[alt], [class*="chat-line"] img[alt], .seventv-emote, .bttv-emote, .ffz-emote, img.emote, img[data-a-target="emote-name"]'

  let found = 0
  for (const img of document.querySelectorAll(combinedSelector)) {
    if (cache.size >= 2300) break
    const name = img.alt || img.getAttribute('data-emote-name')
    const url = img.src
    if (name && url && !cache.has(name) && !emoteCache.has(name)) {
      const source = detectEmoteSource(url)
      // Twitch native emotes are entitlement-gated server-side and arrive
      // per-message via the IRC emotes= tag (twitchExtra). Skipping them
      // here prevents non-entitled senders' text from re-imagifying via
      // this fallback cache.
      if (source === 'twitch') continue
      // 7TV/BTTV/FFZ channel emotes are authoritatively fetched by the
      // background's fetchChannelOwnerEmotes. The DOM scan would otherwise
      // capture other browser extensions' renders of personal emotes (e.g.
      // 7TV browser ext rendering the viewer's own posted emote) and stamp
      // them into channelEmoteCaches as if they were channel-wide. That
      // leaks the viewer's set into every sender's message in this channel.
      if (source === '7tv' || source === 'bttv' || source === 'ffz') continue
      cache.set(name, { url, source, state: getEmoteState(name, source), zeroWidth: false })
      found++
    }
  }

  if (found > 0) {
    log('Scanned', found, 'emotes from DOM ->', ch, ', total:', cache.size)
    // Channel cache grew → picker is stale; queue an idle rebuild so the
    // next open already reflects the new emotes.
    markPickerDirty()
    prebuildPickerIdle()
  }
}

// Periodically scan for new emotes
cleanup.persistInterval(cleanup.setIntervalIfVisible(scanDomForEmotes, 10000))

// Process text and replace emote codes with images.
// Supports 7TV zero-width (overlay) emotes that stack on base emotes.
// Resolution priority (perma sender model): channel > senderEmotes > extraCache (native twitch IRC) > emoteCache (globals) — see the lookup order below (~line 3440); channel is authoritative in its own room
// - extraCache: optional Map<name, emoteData> for per-message Twitch IRC tag emotes
// - senderEmotes: optional Map<name, emoteData> — sender's personal set frozen at first sight.
//   For viewer's own outgoing messages, caller passes viewerPersonalEmotes here.
//   For others' messages, caller passes their fetched 7TV/BTTV personal set (or empty Map if not yet known).
// FFZ/BTTV-style modifier helpers — bridged to lib/modifiers.js
// (HS_MOD_TOKENS, hsModClassify, hsModBuildStyleAttr, hsModInjectWrapperStyle,
// hsModComposeFilter, hsModHexToHue) are bundled by build.js.
const HS_MC_MODS = HS_MOD_TOKENS
const HS_MC_C_RE = HS_MOD_C_HEX_RE
// Static list — hoisted out of the per-word inline-suffix peel so it isn't
// reallocated for every non-resolved word on the message hot path. DERIVED from
// HS_MOD_TOKENS, never hand-listed: the hand-written version had drifted and was
// missing r!/p!/s!/ffzW and every animated ffz* token, so "KappaffzLeave" (space
// eaten by an upstream send pipeline) resolved to nothing. Longest-first so a
// long token wins over any shorter one that ends the same way.
const HS_INLINE_MOD_SUFFIXES = Object.keys(HS_MOD_TOKENS).sort((a, b) => b.length - a.length)
function _hsMcHexToHue(h) {
  return hsModHexToHue(h)
}
function _hsMcApplyMods(html, mods, hue) {
  if (!mods?.length && hue == null) return html
  // Stamp the ORDERED effect list on the wrapper so the hover tooltip can show
  // what was applied and in what sequence. Only the composed transform/filter
  // survives otherwise, which can't be read back into "wide, then cursed".
  // Tokens come from HS_MOD_CLASS_TO_TOKEN, so a synonym (ffzW vs w!) displays
  // as its canonical spelling — the EFFECT and its order are always exact.
  let modsAttr = ''
  try {
    const words = hsModWordsFromState(mods || [], hue)
    if (words.length) modsAttr = ` data-hs-mods="${escapeHtml(words.join(' '))}"`
  } catch {}
  const imgFilter = hsModComposeFilter(mods, hue)
  const hasImg = /<img(\s|>)/.test(html)
  // Emoji spans have no <img> — fold the filter into the wrapper span style
  // (transform + margins always go on the wrapper anyway).
  const wrapperStyle = hsModBuildStyleAttr(mods, null) + (!hasImg && imgFilter ? `filter:${imgFilter} !important;` : '')
  let out = html
  if (modsAttr) out = out.replace(/^(<span\b)/, `$1${modsAttr}`)
  if (wrapperStyle) out = hsModInjectWrapperStyle(out, wrapperStyle)
  if (imgFilter && hasImg) {
    out = out.replace(/<img(\s)/, `<img style="filter:${imgFilter} !important;"$1`)
  }
  // Animated effects (party/shake/rainbow/bounce/jam/spin/slide/arrive/leave)
  // ride on hs-fx-* classes (keyframes in the emote CSS) so they compose with
  // the static transform/filter above. Merge into the img's existing class.
  const animClasses = hsModComposeAnimClasses(mods)
  if (animClasses.length) {
    const cls = animClasses.join(' ')
    if (hasImg) {
      out = /<img\b[^>]*\sclass="/.test(out)
        ? out.replace(/(<img\b[^>]*\sclass=")/, `$1${cls} `)
        : out.replace(/<img\b/, `<img class="${cls}"`)
    } else {
      // No <img> means an emoji base: the glyph IS the wrapper span, so the
      // effect class has to land there instead. Without this the class was
      // simply never emitted for emoji — the static half of a modifier applied
      // (it rides the style attr, folded in above) and the animated half
      // silently did nothing, so `p!` on an emoji read as a frozen tint.
      out = /^<span\b[^>]*\sclass="/.test(out)
        ? out.replace(/^(<span\b[^>]*\sclass=")/, `$1${cls} `)
        : out.replace(/^<span\b/, `<span class="${cls}"`)
    }
  }
  // Stamp the scale factors so the load-time snap can reserve horizontal/vertical
  // space sized to the emote's REAL width (hsModBuildStyleAttr's static margins
  // assume a 28px base and under-reserve for natively-wide emotes like WideBirdge:
  // scaleX(2) makes an 88px emote 176px but only ~28px is reserved → it overflows
  // and overlaps its neighbours). Parsed from the transform we just built.
  const _scaleM = wrapperStyle.match(/transform:\s*scale\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/)
  if (_scaleM && (Math.abs(+_scaleM[1]) > 1 || Math.abs(+_scaleM[2]) > 1)) {
    out = out.replace(/^(<span\b[^>]*?)(>)/, (m, p1, gt) =>
      / data-hs-mod-sx=/.test(p1) ? m : `${p1} data-hs-mod-sx="${_scaleM[1]}" data-hs-mod-sy="${_scaleM[2]}"${gt}`,
    )
  }
  // Stash wire words on the wrapper so left-clicking a nested emote can
  // round-trip modifiers ("w! h! c!#888") into the input on paste.
  const wireWords = hsModWordsFromState(mods, hue).join(' ')
  if (wireWords) {
    const safe = wireWords.replace(/"/g, '&quot;')
    out = out.replace(/^(<span\b[^>]*?)(>)/, (m, p1, gt) =>
      / data-hs-words=/.test(p1) ? m : `${p1} data-hs-words="${safe}"${gt}`,
    )
  }
  return out
}

// ── Bitmap crispness: snap each emote box to an integer outer width ──────
// A non-integer-width inline emote shifts every following glyph on the row
// onto a fractional x. On Linux (where -webkit-font-smoothing:none is a
// no-op) Chrome grayscale-AAs text at sub-pixel origins, so the text AFTER
// an emote renders blurry while text before it stays crisp — the reported
// "emote at start / after punctuation blurs the rest of the line" (position
// is a perception artifact: any emote blurs the text that follows it).
// Rounding the emote box's outer width UP to the next pixel puts the
// post-emote pen back on the same integer-phase grid as ordinary text, so
// the run renders crisp again (measured: post-emote text returns to the
// native text phase in every position). Width is cached by url and
// re-emitted inline by the HTML builders below, so re-sightings paint
// snapped from the first frame — no reflow, no flash. Lazy emojis carry the
// same fractional-advance issue but have no load event to hook — separate.
const _hsEmoteBoxW = new Map() // chat url -> integer px (ceil of natural box width)
const _hsSnapQueue = new Set()
let _hsSnapScheduled = false
const HS_SNAP_QUEUE_CAP = 200
// Attach the integer-width snap to a composer chip. Every chip-creation site
// must call this: a chip with a fractional width puts every character typed
// AFTER it on a fractional x, and the bitmap font smears. Measured live on a
// 51x32 emote at 28px height — box 44.625px, following text at x-fraction
// 0.625; pinned to 45px, the text returns to 0.
// There are FOUR creation paths (paste, typing-imagify, and two emote-cycling
// ones) and hooking only one is exactly how this shipped half-fixed.
function hsAttachInputEmoteSnap(img) {
  if (!img || typeof hsSnapEmoteBox !== 'function') return
  img.addEventListener('load', () => hsSnapEmoteBox(img), { once: true })
  // A cached image fires no load event — that path stayed blurry without this.
  if (img.complete && img.naturalWidth) hsSnapEmoteBox(img)
}

function hsSnapEmoteBox(img) {
  // Input-composer chips are bare IMGs with no wrapper/stack, but they sit
  // inline with typed text and so contribute the same fractional advance that
  // smeared post-emote text in chat rows.
  if (!img?.classList) return
  if (!img.classList.contains('hs-mc-emote') && !img.classList.contains('hs-input-emote')) return
  // A hidden tab has no layout to fix — enqueuing here would leak every emote
  // img appended for the whole backgrounded stream (rAF never fires while
  // hidden, so _hsSnapScheduled latches true), then drain in ONE frame of N
  // offsetWidth reads on refocus ("came back to the tab and it froze"). The
  // visibilitychange handler below re-snaps whatever's mounted on return.
  if (document.hidden) return
  _hsSnapQueue.add(img)
  // Belt-and-suspenders cap: some backgrounding paths (OS tab discard, devtools
  // throttling) don't flip document.hidden. Drop the oldest rather than grow
  // unbounded — a dropped img self-heals on its next sighting (re-render, or
  // the visibilitychange re-snap).
  if (_hsSnapQueue.size > HS_SNAP_QUEUE_CAP) {
    const oldest = _hsSnapQueue.values().next().value
    _hsSnapQueue.delete(oldest)
  }
  if (_hsSnapScheduled) return
  _hsSnapScheduled = true
  cleanup.raf(() => {
    _hsSnapScheduled = false
    const items = []
    for (const im of _hsSnapQueue) {
      // Round the OUTERMOST emote box — the overlay stack when present, else
      // the bare wrapper. That box contributes the inline advance the
      // following text starts after.
      // Bare input chip: the IMG itself is the outermost box.
      const box =
        im.closest('.hs-mc-emote-stack') ||
        im.closest('.hs-mc-emote-wrapper') ||
        (im.classList.contains('hs-input-emote') ? im : null)
      if (box?.isConnected) items.push({ box, im })
    }
    _hsSnapQueue.clear()
    // Read every width first, then write — one layout pass per frame. Use
    // offsetWidth, NOT getBoundingClientRect: a wide/tall modifier (w!/ffzW/h!)
    // applies a CSS transform:scale to the box, and getBoundingClientRect INCLUDES
    // that scale. Pinning the scaled value as style.width would re-scale it every
    // render (2x → 4x → runs off-screen — the reported "WideBirdge ffzW even more
    // off-screen after refresh"). offsetWidth is the untransformed layout width,
    // which is also what the following text actually flows after (transforms don't
    // move siblings), so it's the correct measure for the box-reservation too.
    for (const it of items) {
      it.w = it.box.offsetWidth
      // The img's own wrapper — inside a stack it's a grid item under
      // place-items:center (shrink-to-fit), so its width IS the emote's solo
      // width. Read it here for the stack-member caching below.
      const mw = it.im.closest('.hs-mc-emote-wrapper')
      if (mw) {
        it.selfWrap = mw
        it.selfW = mw.offsetWidth
      }
      // A modifier scale (w!/ffzW/h!) must reserve space sized to the emote's
      // REAL untransformed width — capture its own wrapper's box now, apply below.
      if (mw?.dataset.hsModSx) {
        it.modWrap = mw
        it.modW = mw.offsetWidth
        it.modH = mw.offsetHeight
      }
    }
    for (const it of items) {
      // Skip a mid-flight / fallback-swapping image: measuring + caching its box
      // now would pin a width from a transitional (or not-yet-decoded) asset under
      // the stable emote-url key, and a later render would apply that wrong width.
      if (!it.w || !it.im.complete || !it.im.naturalWidth) continue
      const px = `${it.w}px`
      if (it.box.style.width !== px) it.box.style.width = px
      // Accurate modifier space reservation: the static margins in
      // hsModBuildStyleAttr assume a 28px base, so a natively-wide emote scaled
      // by w!/ffzW overflows + overlaps. Now that the emote is loaded we know its
      // real width — reserve exactly (width * (scale-1) / 2) on each side so a run
      // of wide/tall-modified emotes tiles cleanly instead of stacking on top of
      // each other. Overrides the fallback margins (setProperty important).
      if (it.modWrap) {
        const sx = Math.abs(parseFloat(it.modWrap.dataset.hsModSx) || 1)
        const sy = Math.abs(parseFloat(it.modWrap.dataset.hsModSy) || 1)
        if (sx > 1 && it.modW) {
          const m = `${Math.round((it.modW * (sx - 1)) / 2)}px`
          it.modWrap.style.setProperty('margin-left', m, 'important')
          it.modWrap.style.setProperty('margin-right', m, 'important')
        }
        if (sy > 1 && it.modH) {
          const m = `${Math.round((it.modH * (sy - 1)) / 2)}px`
          it.modWrap.style.setProperty('margin-top', m, 'important')
          it.modWrap.style.setProperty('margin-bottom', m, 'important')
        }
      }
      // Stack members (base AND overlay): the OUTER stack box width is the
      // widest child, never cacheable under any single url. But each member's
      // own wrapper (grid item, shrink-to-fit) IS that emote's solo width —
      // cache it, so renderEmoteStack can reserve the stack's inline advance
      // on the NEXT sighting before any decode (the emoji+overlay decode
      // re-wrap was the reported chat jank). Skip mod-scaled wrappers: their
      // margins distort the box.
      if (it.box.classList.contains('hs-mc-emote-stack') || it.im.classList.contains('hs-mc-overlay-emote')) {
        if (it.selfWrap && !it.selfWrap.dataset.hsModSx && it.selfW) {
          const surl = it.selfWrap.dataset?.emoteUrl || it.im.getAttribute('src')
          if (surl && !_hsEmoteBoxW.has(surl)) {
            _hsEmoteBoxW.set(surl, it.selfW)
            if (_hsEmoteBoxW.size > 2000) _hsEmoteBoxW.delete(_hsEmoteBoxW.keys().next().value)
          }
        }
        continue
      }
      const url = it.im.closest('.hs-mc-emote-wrapper')?.dataset?.emoteUrl || it.im.getAttribute('src')
      if (url) {
        _hsEmoteBoxW.set(url, it.w)
        // FIFO cap — a long multi-channel session measures thousands of unique
        // emote URLs; without eviction this Map grows unbounded for the tab's life.
        if (_hsEmoteBoxW.size > 2000) _hsEmoteBoxW.delete(_hsEmoteBoxW.keys().next().value)
      }
    }
  })
}
// hsSnapEmoteBox skips enqueuing entirely while hidden (no layout to fix), so
// nothing accumulates during a backgrounded stream — but that also means any
// emote img appended while hidden never gets snapped. Re-arm on hide (a
// scheduled-but-never-fired rAF would otherwise latch _hsSnapScheduled true
// forever, silently no-oping every enqueue attempt after return — see the
// project invariant that document.hidden freezes render) and re-snap every
// emote currently mounted once the tab is visible again.
// Guarded: this file is also `import`ed directly by unit tests running under
// bun (no DOM, no window) that stub only the specific cleanup methods each
// test exercises — skip registration there rather than requiring every such
// test to also stub addEventListener.
if (typeof document !== 'undefined' && typeof cleanup?.addEventListener === 'function') {
  cleanup.addEventListener(document, 'visibilitychange', () => {
    if (document.hidden) {
      _hsSnapQueue.clear()
      _hsSnapScheduled = false
      return
    }
    for (const im of document.querySelectorAll('img.hs-mc-emote, img.hs-input-emote')) {
      if (im.isConnected) hsSnapEmoteBox(im)
    }
  })
}

// @param {boolean} skipMentions  Skip this function's own plain @mention→<a>
//   wrap (still emits the word as plain escaped text). Pass true when the
//   caller runs highlightMentionsInHtml (main.js) on the result afterward —
//   that is the single source of truth for mention anchors (uid resolution,
//   HeatSync-paint/7TV precedence, letter-split). Without this flag, a chat
//   message containing "@name" gets wrapped HERE first (plain <a>, no uid)
//   and then AGAIN by highlightMentionsInHtml around the same text, producing
//   a nested <a>…<a>…</a></a>. Nested anchors are invalid HTML5 — browsers
//   auto-close the outer one the instant the inner <a> opens, leaving a
//   permanently EMPTY sibling anchor (no uid, no paint class, no text) right
//   next to the real one — verified live via Chrome DOM inspection. That
//   empty husk is exactly the "painted username renders blank" bug: it
//   carries a normal-looking inline color style (set by this function) but
//   zero content, because the real text/uid/paint ended up on its orphaned
//   sibling instead. Callers
//   that do NOT run highlightMentionsInHtml afterward (whispers.js,
//   twitch-api.js prediction/outcome titles, main.js's compact/system-line
//   render) must keep skipMentions=false — this function's own wrap is the
//   only mention coloring those surfaces get.

// Own-inventory emotes carry cwCats (server annotation — own sets are never
// filtered or stubbed). At render, the OWNER's own viewer_show_* toggles
// decide visibility: first hidden category wins and the emote paints the same
// dashed-cyan placeholder as a cross-user cw stub. Setting keys are singular
// for weapon/drug (settings-schema.js) while server categories are plural.
const HS_CW_SETTING_BY_CAT = {
  sexual: 'viewer_show_sexual',
  gore: 'viewer_show_gore',
  weapons: 'viewer_show_weapon',
  drugs: 'viewer_show_drug',
  hate: 'viewer_show_hate',
}
function hsOwnCwHiddenCat(emote) {
  const cats = emote?.cwCats
  if (!Array.isArray(cats) || cats.length === 0) return ''
  if (typeof getSetting !== 'function') return ''
  for (const cat of cats) {
    const key = HS_CW_SETTING_BY_CAT[cat]
    if (key && getSetting(key) === false) return cat
  }
  return ''
}

// Channel 7TV sets are fetched directly from 7tv.io (_buildChannelEmoteCache),
// bypassing the heatsync server's content filter entirely — unlike the
// server-served global/inventory pools, a channel-set sexual emote's `nsfw`
// flag is unfiltered and has to be checked against the viewer's OWN setting
// at render time. Server-filtered pools never reach here with nsfw:true while
// the setting is off (the server already swapped those for a cw stub), so
// this is a no-op for them — safe to apply unconditionally.
function hsChannelNsfwHidden(emote) {
  if (!emote?.nsfw) return false
  return typeof getSetting === 'function' && getSetting('viewer_show_sexual') === false
}

// cw stub markup shared by every render branch that can hit a filter-hidden
// emote (generic + kick [emote:id:name]) — no <img>, a labeled dashed box
// marks the spot so the message reads as "emote hidden here". cwCat and
// displayName must already be escapeHtml'd by the caller.
// boxW (optional): a previously-observed rendered box width for this same
// emote URL (_hsEmoteBoxW — the cache the normal wrapper's wAttr already
// reads). When known, the stub takes that exact footprint so a filter-pref
// toggle causes zero layout shift; the height/min-width floor live in the
// --sized CSS class. Mirrors the website's hs-emote-cw--sized, adapted to
// the ext's measured-box cache since there's no server-sent natural size here.
function _hsCwBoxHtml(cwCat, displayName, boxW) {
  const sized = boxW > 0
  const sizedClass = sized ? ' hs-mc-emote-cw--sized' : ''
  const wAttr = sized ? ` style="width:${boxW}px"` : ''
  return `<span class="hs-mc-emote-wrapper hs-mc-emote-cw${sizedClass}" data-emote-name="${displayName}" data-cw="${cwCat}" data-state="cw"${wAttr} title="${displayName}">${cwCat}</span>`
}

function processEmotes(text, channel, extraCache, senderEmotes, msgTime, skipMentions = false, msgRefs = null) {
  if (
    emoteCache.size === 0 &&
    !channelEmoteCaches[channel] &&
    !extraCache?.size &&
    !senderEmotes?.size &&
    !msgRefs?.size
  )
    return text
  // Removed-emote render fallback applies ONLY to the viewer's own messages
  // (main.js passes viewerPersonalEmotes by reference for isOwn). Keeps removed
  // heatsync emotes drawing in the viewer's history without leaking into others.
  // Gated additionally by msgTime: fallback applies only to messages that
  // pre-date the removal — newly-sent posts after remove stay raw.
  // Inventory renders are opt-out: off, every inventory-resolved name stays
  // plain text (yours and every other sender's). Channel/global/native pools
  // are untouched — those render for everyone on the platform anyway, so
  // silencing them here would just desync this client from what was sent.
  const _invRender = getSetting('renderInventoryEmotes') !== false
  const _rf = _invRender && senderEmotes === viewerPersonalEmotes ? removedEmoteFallback : null
  const _rfGate = (entry) => {
    if (!entry) return null
    if (typeof msgTime !== 'number' || !entry.removedAt) return entry // unknown time → preserve old behavior
    return msgTime < entry.removedAt ? entry : null
  }
  // Inventory-time gate for per-sender sets (and own inventory): a heatsync
  // emote renders only in messages sent while the sender actually owned it —
  // addedAt ≤ msgTime < removedAt. History is frozen at send-time truth: a
  // fresh collect doesn't retro-imagify older messages, and an uncollect
  // doesn't retro-textify rows that were legitimately rendered (tombstoned
  // entries keep their interval, see dropEmoteFromAllSenders). Entries with
  // no stamps (7TV/BTTV personal sets, pre-stamp caches) and messages with
  // no timestamp render ungated. The skew pad absorbs server-vs-platform
  // clock drift on the collect→send fast path.
  const _sGate = (entry) => {
    if (!entry || typeof msgTime !== 'number') return entry || null
    if (entry.addedAt && msgTime < entry.addedAt - EMOTE_ADDED_SKEW_MS) return null
    if (entry.removedAt && msgTime >= entry.removedAt) return null
    return entry
  }
  const _sGet = (name) => (_invRender ? _sGate(senderEmotes?.get(name)) : null)
  // Provenance-aware resolve: channel > sender inventory > native > global >
  // removed-inventory fallback. `inv` marks hits that render BECAUSE of a
  // heatsync inventory (the sender's, or the viewer's own) — the tooltip
  // attributes those to the inventory instead of the emote's original
  // provider, which the viewer may have no relationship with (same emote
  // labeled "set" on own rows but "7TV" on the sender's).
  const _lookup = (name) => {
    // `name` is an HTML-escaped token: main.js runs escapeHtml(m.text) before
    // processEmotes, so a name with HTML specials arrives escaped (`>:3` →
    // `&gt;:3`, `<3` → `&lt;3`). The channel/sender/global/removed caches are
    // keyed by RAW emote names, so we must unescape before those lookups or
    // the emote renders as plain text. extraCache (twitchExtra) is keyed by
    // the escaped name to match this token directly. escapeHtml is identity
    // for names without specials, so raw === name on the hot path (no `&`).
    const raw = name.indexOf('&') === -1 ? name : unescapeHtml(name)
    let e = channel ? channelEmoteCaches[channel]?.get(raw) : null
    if (e) return { e, inv: false }
    // Server-enriched per-message refs: the sender's inventory emote actually
    // used in THIS message, resolved authoritatively server-side. Wins over the
    // lazily-fetched sender set (which may be stale/unfetched) but yields to the
    // channel's own set above. Ungated by _sGate — it's current by construction.
    e = msgRefs?.get(name)
    if (e) return { e, inv: true }
    e = _sGet(raw)
    if (e) return { e, inv: true }
    e = extraCache?.get(name) || emoteCache.get(raw)
    if (e) return { e, inv: false }
    e = _rfGate(_rf?.get(raw))
    return e ? { e, inv: true } : null
  }

  // Kick emote splits gated by indexOf — Kick text is <5% of overall msg volume;
  // skipping 3 replaces on Twitch/YT messages saves allocations per message.
  // Unicode emoji split always applies: separate emoji from adjacent non-emoji.
  // Multi-codepoint sequences (skin tone, ZWJ, VS16) stay intact.
  let pre = text
  // Kick wraps native emotes as [emote:ID:name]; the per-word match below is
  // gated on this flag so Twitch/YT traffic (~95% of volume, zero [emote:
  // tokens) skips the regex on every word. The space-inserting replaces only
  // add/remove whitespace around an existing [emote: literal, never the literal
  // itself, so the flag stays valid for the tokenized `pre`.
  const hasKickEmote = pre.indexOf('[emote:') !== -1
  if (hasKickEmote) {
    pre = pre
      .replace(/\]\[emote:/g, '] [emote:')
      .replace(/([^\s[])\[emote:/g, '$1 [emote:')
      .replace(/\]([^\s\]])/g, '] $1')
  }
  // ASCII fast-path: skip the two Unicode-property emoji-split regexes when
  // the message has no high-byte characters. Pure-ASCII messages are the
  // overwhelming majority of Twitch/Kick traffic; the /gu lookbehind regex
  // is the single most expensive per-message operation otherwise.
  let words
  let asciiOnly = true
  for (let i = 0; i < pre.length; i++) {
    if (pre.charCodeAt(i) > 127) {
      asciiOnly = false
      break
    }
  }
  if (asciiOnly) {
    words = pre.split(/(\s+)/)
  } else {
    words = pre
      .replace(
        /([\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])(?=[^\s\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D])/gu,
        '$1 ',
      )
      .replace(/([^\s\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D])(?=\p{Extended_Pictographic})/gu, '$1 ')
      .split(/(\s+)/)
  }
  const result = []
  // pendingStack tracks an items list. Each item (base OR overlay) has its
  // OWN mods/hue. Modifier tokens attach to the LAST item — so
  // "Kappa RainTime w!" makes RainTime wide, not Kappa.
  let pendingStack = null // { items: [{ kind, raw, mods, hue }] }
  let pendingWhitespace = ''
  let pendingMods = []
  let pendingHue = null

  const _lastItem = () => (pendingStack?.items.length ? pendingStack.items[pendingStack.items.length - 1] : null)

  const _flushStackToResult = () => {
    if (!pendingStack?.items.length) {
      pendingStack = null
      return
    }
    const items = pendingStack.items
    const baseHtml = _hsMcApplyMods(items[0].raw, items[0].mods, items[0].hue)
    const overlays = items.slice(1).map((it) => _hsMcApplyMods(it.raw, it.mods, it.hue))
    result.push(renderEmoteStack({ base: baseHtml, overlays }))
    pendingStack = null
  }

  for (let _wIdx = 0; _wIdx < words.length; _wIdx++) {
    const word = words[_wIdx]
    // Whitespace - accumulate, don't flush yet (overlays are space-separated)
    if (WS_RE.test(word)) {
      pendingWhitespace += word
      continue
    }

    // ── Modifier binding ────────────────────────────────────────────────
    // BTTV and FFZ disagree, verified against both providers' own APIs/docs:
    //   BTTV (c! w! h! v! z! l! r! p! s!) modifies the FOLLOWING emote
    //   FFZ  (ffzX ffzW ffzY ffzCursed …) modifies the PRECEDING emote
    //   7TV  zero-width overlays also attach to the PRECEDING emote
    // So each token binds in ITS OWN provider's canonical direction FIRST. The
    // opposite direction is only a fallback for when the canonical side has no
    // emote — that ordering matters: if the fallback could win, then
    // "Kappa c! Keepo" would modify Kappa for us and Keepo for every BTTV
    // user, and multi-emote runs are exactly where interop breaks visibly.
    // A token with an emote on NEITHER side stays literal text (never
    // swallowed — that regression is why the orphan guard exists below).
    const _modForward = (w) => w.endsWith('!') // BTTV token shape; ffz* are backward
    // Is there an emote ahead before any plain word? Skips intervening
    // modifiers so "c! ffzX Kappa" lands both on Kappa.
    const _emoteComesNext = (from) => {
      for (let j = from; j < words.length; j++) {
        const w = words[j]
        if (WS_RE.test(w)) continue
        if (HS_MC_MODS[w] || HS_MC_C_RE.test(w)) continue
        if (hasKickEmote && /^\[emote:\d+:[^\]]+\]$/.test(w)) return true
        return !!_lookup(w)?.e
      }
      return false
    }

    // FFZ semantic: modifier attaches to the IMMEDIATELY PRECEDING emote.
    // Kappa RainTime w! → wide RainTime (not Kappa).
    // FFZ modifiers attach to the IMMEDIATELY PRECEDING emote. If there's no
    // emote in the current stack to attach to (e.g. the base failed to resolve
    // from a cold cache after a refresh), the modifier is ORPHANED — it must
    // render as literal text, NOT be silently swallowed. Swallowing it into
    // pendingMods (the old behavior) dropped it entirely when no following emote
    // consumed it — the reported "WideBirdge ffzW ..." → plain "WideBirdge"
    // repeated, every ffzW eaten. So each modifier branch only consumes the token
    // when _lastItem() exists; otherwise it falls through to the text path below.
    const modKind = HS_MC_MODS[word]
    if (modKind) {
      const fwd = _modForward(word)
      // canonical direction first, opposite as fallback, else fall through to text
      if (fwd && _emoteComesNext(_wIdx + 1)) {
        pendingMods.push(modKind)
        pendingWhitespace = ''
        continue
      }
      if (_lastItem()) {
        _lastItem().mods.push(modKind)
        pendingWhitespace = ''
        continue
      }
      if (!fwd && _emoteComesNext(_wIdx + 1)) {
        pendingMods.push(modKind)
        pendingWhitespace = ''
        continue
      }
    }
    const cMatchTok = word.match(HS_MC_C_RE)
    if (cMatchTok) {
      // c!#hex is a BTTV-shaped token — forward first, same as its siblings.
      const hueVal = _hsMcHexToHue(cMatchTok[1])
      if (_emoteComesNext(_wIdx + 1)) {
        pendingHue = hueVal
        pendingWhitespace = ''
        continue
      }
      if (_lastItem()) {
        _lastItem().hue = hueVal
        pendingWhitespace = ''
        continue
      }
    }
    // Peel chained modifier word (e.g. "w!h!ffzX" or "w!c!#888h!"). Chaining is
    // a heatsync-ism — no provider parses it — so direction follows the word's
    // FIRST token, matching what the user led with and keeping the rule
    // identical to the single-token case above.
    const _hsPeel = _lastItem() || _emoteComesNext(_wIdx + 1) ? hsModPeelChain(word) : null
    if (_hsPeel) {
      const chainFwd = _modForward(word)
      const target = chainFwd && _emoteComesNext(_wIdx + 1) ? null : _lastItem()
      if (target) {
        for (const m of _hsPeel.mods) target.mods.push(m)
        if (_hsPeel.hue != null) target.hue = _hsPeel.hue
      } else {
        // forward: ride pendingMods onto the emote that follows
        for (const m of _hsPeel.mods) pendingMods.push(m)
        if (_hsPeel.hue != null) pendingHue = _hsPeel.hue
      }
      pendingWhitespace = ''
      continue
    }

    // Kick emote format: [emote:ID:NAME] -> render as image from Kick CDN.
    // When the name matches a known 7TV/BTTV/FFZ/heatsync entry, prefer that
    // entry's URL (animated/full-quality), carry its hash (for block/add),
    // and honor zero-width so overlay stacking matches Twitch parity.
    const kickEmoteMatch = hasKickEmote ? word.match(/^\[emote:(\d+):([^\]]+)\]$/) : null
    if (kickEmoteMatch) {
      const [, emoteId, emoteName] = kickEmoteMatch
      const kickUrl = `https://files.kick.com/emotes/${emoteId}/fullsize`
      // _lookup applies the inventory-time gate here too (sender path was
      // previously ungated on kick tokens — an oversight vs the twitch path).
      const _kickHit = _lookup(emoteName)
      const cached = _kickHit?.e
      const cachedInv = !!_kickHit?.inv
      const useCachedUrl = !!(cached?.url && !/^https?:\/\/files\.kick\.com\//i.test(cached.url))
      const finalUrl = useCachedUrl ? cached.url : kickUrl
      const provider = cached?.source || 'kick'
      const isOverlay = !!cached?.zeroWidth || (cached && zeroWidthFromAnyCache(emoteName))
      // emoteName is extracted from escaped text — check raw form against the
      // raw-keyed blocked/inventory stores and escape from raw (no double).
      // Guard: escapeHtml is identity for names without specials, so skip the
      // unescape when there's nothing to undo (runs once per Kick emote token).
      const rawEmoteName = emoteName.indexOf('&') === -1 ? emoteName : unescapeHtml(emoteName)
      // hash check catches the same asset re-listed under a different alias —
      // the kick numeric id IS the stored hash (background.js hash: String(e.id)).
      const isBlocked =
        blockedEmoteNames.has(emoteName) ||
        blockedEmoteNames.has(rawEmoteName) ||
        blockedEmoteHashes.has(String(emoteId))
      let state = isBlocked ? 'blocked' : cached?.state || 'channel'
      if (state === 'unadded' && (inventoryEmotes.has(emoteName) || inventoryEmotes.has(rawEmoteName))) state = 'owned'
      const safeName = escapeHtml(rawEmoteName)
      const chatUrl = getChatResUrl(finalUrl)
      const safeUrlAttr = escapeHtml(chatUrl)
      const safeSrc = escapeHtml(staticEmoteSrc(chatUrl))
      const safeProvider = escapeHtml(provider)
      const safeHash = cached?.hash ? escapeHtml(cached.hash) : ''
      const ownerAttr = cached?.ownerDisplay ? ` data-owner="${escapeHtml(cached.ownerDisplay)}"` : ''
      const titleAttr = useCachedUrl ? safeName : `${safeName} (${safeProvider} via kick)`
      const nsfwClass = cached?.nsfw ? ' hs-state-nsfw' : ''
      const _boxW = _hsEmoteBoxW.get(chatUrl)
      const wAttr = _boxW ? ` style="width:${_boxW}px"` : ''
      const _os = useCachedUrl ? _hsEmoteOversize(cached) : 0
      const osAttr = _os ? ` style="--hs-os:${_os}"` : ''
      // Only inventory-attributed when the inventory URL actually renders.
      const invAttr = cachedInv && useCachedUrl ? ' data-inv="1"' : ''
      // cw gate — mirror the generic branch: a resolved cached emote carrying
      // a cw category (server stub or the viewer's own hidden-category toggle)
      // renders the dashed placeholder box, never the image.
      const _kickCwRaw =
        (cached && typeof cached.cw === 'string' && cached.cw) ||
        hsOwnCwHiddenCat(cached) ||
        (hsChannelNsfwHidden(cached) ? 'sexual' : '')
      const kickCwCat = _kickCwRaw ? escapeHtml(_kickCwRaw) : ''
      const imgHtmlRaw = kickCwCat
        ? _hsCwBoxHtml(kickCwCat, safeName, _boxW)
        : `<span class="hs-mc-emote-wrapper hs-state-${state}${nsfwClass}" data-emote-name="${safeName}" data-emote-url="${safeUrlAttr}" data-state="${state}" data-source="${safeProvider}"${ownerAttr}${invAttr}${safeHash ? ` data-emote-hash="${safeHash}"` : ''}${wAttr}><img src="${safeSrc}" alt="${safeName}" title="${titleAttr}" class="hs-mc-emote hs-emote-${state}"${osAttr} data-emote-name="${safeName}" data-state="${state}" data-source="${safeProvider}"${ownerAttr}${invAttr} loading="lazy" decoding="async"></span>`
      if (isOverlay && pendingStack) {
        const itemMods = pendingMods.slice()
        const itemHue = pendingHue
        pendingMods = []
        pendingHue = null
        pendingStack.items.push({ kind: 'overlay', raw: imgHtmlRaw, mods: itemMods, hue: itemHue })
        pendingWhitespace = ''
      } else {
        _flushStackToResult()
        if (pendingWhitespace) {
          result.push(pendingWhitespace)
          pendingWhitespace = ''
        }
        pendingStack = { items: [{ kind: 'base', raw: imgHtmlRaw, mods: pendingMods.slice(), hue: pendingHue }] }
        pendingMods = []
        pendingHue = null
      }
      continue
    }

    // Resolve the emote. A literal full-name hit ALWAYS wins — an emote
    // actually named "lerolero0" is a standalone emote, NOT the "lerolero"
    // overlay. Only when the literal name doesn't exist do we apply the
    // 7TV-style "name0" convention (strip the trailing 0 and overlay the
    // base). This MUST match lookupEmoteWithOverlay (input preview) so the
    // input chip and the rendered message agree.
    // Priority: channel > senderEmotes > extraCache (twitch IRC native) > emoteCache (globals).
    // Channel emotes are AUTHORITATIVE in their own channel for every sender
    // (mirrors chrome/content.js cachedOwnEmotes): nl_kripp's channel "Cabge"
    // must win over a sender's colliding personal 7TV "Cabge", so the viewer
    // sees the same image whether they or someone else posts the name. The
    // per-sender set (viewer inventory on own msgs, sender's personal 7TV on
    // others') still fills every name the channel doesn't carry — sovereignty
    // intact. Without this, others' messages diverged from the viewer's own.
    let emote = null
    let emoteFromInv = false
    let isOverlayEmote = false
    let overlayBaseName = null
    const endsWithZero = word.endsWith('0') && word.length > 1
    const _hit = _lookup(word)
    if (_hit) {
      emote = _hit.e
      emoteFromInv = _hit.inv
    }
    // blockedEmoteFallback last + ungated (block is viewer-wide, all senders):
    // resolves a blocked emote to its real url+dims so it renders the dashed box
    // at the emote's true rectangle via the normal path, instead of the square
    // 1×1-placeholder branch below. Only when a real url is stored (url-less
    // blocks — name-as-hash — still fall through to the square box).
    if (!emote) {
      // blockedEmoteFallback is keyed by RAW names (picker/server side); the
      // escaped `word` misses for specials (`>:3`) — try the raw form too.
      // Guard the unescape call: this runs for EVERY non-emote word (the
      // common case), and word.indexOf('&') === -1 (no specials) means the
      // raw form is identical — skip the redundant unescape + second .get.
      const _bf =
        blockedEmoteFallback.get(word) || (word.indexOf('&') !== -1 && blockedEmoteFallback.get(unescapeHtml(word)))
      if (_bf?.url) emote = _bf
    }
    if (emote) {
      // Real literal hit: overlay ONLY via the zeroWidth flag, never the
      // trailing-0 heuristic. Own outgoing messages resolve via senderEmotes
      // (viewerPersonalEmotes), which lacks the 7TV flag — recover it from
      // channel/global caches so an overlay emote you own still stacks.
      isOverlayEmote = !!emote.zeroWidth
      if (!isOverlayEmote && zeroWidthFromAnyCache(word)) isOverlayEmote = true
    } else if (endsWithZero) {
      // No literal "name0" emote — strip the 0 and overlay the base.
      const baseName = word.slice(0, -1)
      const _baseHit = _lookup(baseName)
      if (_baseHit) {
        emote = _baseHit.e
        emoteFromInv = _baseHit.inv
      }
      if (emote) {
        isOverlayEmote = true
        overlayBaseName = baseName
      }
    }
    // FFZ-style fallback: token like "Kappaw!" or "KappaffzX" — when the
    // upstream send pipeline strips the space between emote and modifier,
    // try peeling a known modifier suffix and re-resolving the base name.
    // Only consider modifier suffixes (not random emote-name endings).
    let _hsInlineModSuffix = null
    if (!emote && word.length > 2) {
      for (const suf of HS_INLINE_MOD_SUFFIXES) {
        if (word.endsWith(suf) && word.length > suf.length + 1) {
          const baseGuess = word.slice(0, word.length - suf.length)
          const candHit = _lookup(baseGuess)
          if (candHit) {
            emote = candHit.e
            emoteFromInv = candHit.inv
            isOverlayEmote = !!emote.zeroWidth
            _hsInlineModSuffix = HS_MC_MODS[suf] || null
            // resolved from the peeled base — a block on the base must hide
            // "Basew!" too, same as the trailing-0 overlay path
            overlayBaseName = baseGuess
            break
          }
        }
      }
      // c!#hex inline (KappaC!#888 — also try)
      if (!emote) {
        const inlineColor = word.match(/^(.+?)(c!#?[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)$/)
        if (inlineColor) {
          const baseGuess = inlineColor[1]
          const candHit = _lookup(baseGuess)
          if (candHit) {
            emote = candHit.e
            emoteFromInv = candHit.inv
            isOverlayEmote = !!emote.zeroWidth
            overlayBaseName = baseGuess
            const m = inlineColor[2].match(HS_MC_C_RE)
            if (m) _hsInlineModSuffix = { hue: _hsMcHexToHue(m[1]) }
          }
        }
      }
    }
    if (emote) {
      // `word` is an already-escaped token (&lt;3 for <3). Blocked/inventory
      // stores hold RAW names (picker/server side), so check the raw form too
      // — and escape from raw so attrs aren't double-escaped (&amp;lt;3 alt).
      // Guard: skip the unescape when word has no specials (the common case,
      // runs per resolved emote) — the raw form would just equal word.
      const rawWord = word.indexOf('&') === -1 ? word : unescapeHtml(word)
      // trailing-0 overlay resolved from the BASE name — a block on the base
      // must hide the overlay too ("name0" itself is never in the block set)
      // hash check catches the same underlying asset re-listed under a
      // different alias (7tv per-set alias, kick re-list) — name-only checks
      // miss that case entirely.
      const isBlocked =
        blockedEmoteNames.has(word) ||
        blockedEmoteNames.has(rawWord) ||
        (overlayBaseName !== null &&
          (blockedEmoteNames.has(overlayBaseName) ||
            (overlayBaseName.indexOf('&') !== -1 && blockedEmoteNames.has(unescapeHtml(overlayBaseName))))) ||
        (emote.hash && blockedEmoteHashes.has(String(emote.hash)))
      let state = isBlocked ? 'blocked' : emote.state || 'global'
      // Upgrade 'unadded' → 'owned' when the viewer actually has this name
      // in their inventory. Visually identical under 2-state, but downstream
      // auto-add-on-send + cross-user rendering gates read dataset.state.
      if (state === 'unadded' && (inventoryEmotes.has(word) || inventoryEmotes.has(rawWord))) state = 'owned'
      const source = escapeHtml(emote.source || 'unknown')
      const rawChatUrl = getChatResUrl(emote.url)
      const imgSrc = escapeHtml(rawChatUrl)
      const staticSrc = escapeHtml(staticEmoteSrc(rawChatUrl))
      const safeHash = emote.hash ? escapeHtml(emote.hash) : ''
      const displayName = escapeHtml(rawWord)
      const ownerAttr = emote.ownerDisplay ? ` data-owner="${escapeHtml(emote.ownerDisplay)}"` : ''
      // Stale-emote ghost: an emote is stale only if THIS message's channel
      // removed it AND it isn't in the channel's current set. The live set is
      // the source of truth — a name present in channelEmoteCaches[channel]
      // can never be stale. That self-heals re-adds whose event we missed and
      // stops a removal in one channel from ghosting the same name in another
      // (the stream is merged, so every channel shares one render path).
      let staleClass = '',
        staleAttr = ''
      try {
        const chKey = (channel || '').toLowerCase()
        const meta = chKey && window._hsStaleEmotes ? window._hsStaleEmotes.get(chKey)?.get(word) : null
        if (meta) {
          const liveSet = channelEmoteCaches[chKey] || channelEmoteCaches[channel]
          const liveNow = !!liveSet?.has(word)
          // Identity: only ghost the emote that was actually removed. Trust the
          // hash when both sides have one; else require the same provider —
          // removal events only cover 7TV channel emotes, so a same-name global
          // or BTTV emote of different art stays normal.
          const sameEmote =
            meta.hash && emote.hash ? meta.hash === emote.hash : (emote.source || '7tv') === (meta.provider || '7tv')
          if (!liveNow && sameEmote) {
            staleClass = ' hs-state-stale'
            if (meta.actor) staleAttr += ` data-stale-actor="${escapeHtml(meta.actor)}"`
            if (meta.at) staleAttr += ` data-stale-at="${meta.at}"`
          }
        }
      } catch (_) {}
      const nsfwClass = emote.nsfw ? ' hs-state-nsfw' : ''
      const _boxW = _hsEmoteBoxW.get(rawChatUrl)
      const wAttr = _boxW ? ` style="width:${_boxW}px"` : ''
      const _os = _hsEmoteOversize(emote)
      const osAttr = _os ? ` style="--hs-os:${_os}"` : ''
      // Inventory provenance for the hover tooltip — see _lookup above.
      const invAttr = emoteFromInv ? ' data-inv="1"' : ''
      // cw stub — server replaced a filter-hidden emote with {name, cw}. No
      // img (there is no url); a labeled dashed-cyan box marks the spot so
      // the message reads as "emote hidden here", not silently as raw text.
      // Own-inventory entries are never stubbed (server annotates cwCats
      // instead) — honor the OWNER's own toggles at render so their own
      // posted emotes hide too. Picker/composer keep the real image.
      // hsChannelNsfwHidden covers channel 7tv sets, which fetch straight from
      // 7tv.io and carry an unfiltered nsfw flag (see _buildChannelEmoteCache).
      const _cwRaw =
        (typeof emote.cw === 'string' && emote.cw) ||
        hsOwnCwHiddenCat(emote) ||
        (hsChannelNsfwHidden(emote) ? 'sexual' : '')
      const cwCat = _cwRaw ? escapeHtml(_cwRaw) : ''
      const imgHtmlRaw = cwCat
        ? _hsCwBoxHtml(cwCat, displayName, _boxW)
        : `<span class="hs-mc-emote-wrapper hs-state-${state}${staleClass}${nsfwClass}" data-emote-name="${displayName}" data-emote-url="${imgSrc}" data-state="${state}" data-source="${source}"${ownerAttr}${invAttr}${safeHash ? ` data-emote-hash="${safeHash}"` : ''}${staleAttr}${wAttr}><img src="${staticSrc}" alt="${displayName}" title="${displayName}" class="hs-mc-emote hs-emote-${state}"${osAttr} data-emote-name="${displayName}" data-state="${state}" data-source="${source}"${ownerAttr}${invAttr} loading="lazy" decoding="async"></span>`

      // Build the new item — inline-glued suffix mod attaches to THIS emote
      // (e.g. "RainTimew!" → wide RainTime, not wide whatever-was-base).
      const itemMods = []
      let itemHue = null
      if (_hsInlineModSuffix) {
        if (typeof _hsInlineModSuffix === 'string') itemMods.push(_hsInlineModSuffix)
        else if (_hsInlineModSuffix.hue != null) itemHue = _hsInlineModSuffix.hue
      }
      if (isOverlayEmote && pendingStack) {
        // Append as overlay item in the current group; floating mods (none yet
        // typically) drain onto this overlay
        for (const m of pendingMods) itemMods.push(m)
        if (pendingHue != null && itemHue == null) itemHue = pendingHue
        pendingMods = []
        pendingHue = null
        pendingStack.items.push({ kind: 'overlay', raw: imgHtmlRaw, mods: itemMods, hue: itemHue })
        pendingWhitespace = ''
      } else {
        // New group — base (or overlay-without-base which becomes promoted base)
        _flushStackToResult()
        if (pendingWhitespace) {
          result.push(pendingWhitespace)
          pendingWhitespace = ''
        }
        for (const m of pendingMods) itemMods.push(m)
        if (pendingHue != null && itemHue == null) itemHue = pendingHue
        pendingMods = []
        pendingHue = null
        pendingStack = { items: [{ kind: 'base', raw: imgHtmlRaw, mods: itemMods, hue: itemHue }] }
      }
    } else {
      // Emoji :shortcode: — stackable base, OR ":shortcode:0" overlay marker.
      // Mirrors the emote "name0" convention: a trailing 0 makes the emoji an
      // overlay that sits ON TOP of the previous token instead of beside it.
      if (typeof EMOJI_BY_NAME !== 'undefined' && word.startsWith(':') && word.length > 2) {
        const emojiOverlay = word.endsWith(':0') && word.length > 3
        const core = emojiOverlay ? word.slice(0, -1) : word // ":smile:0" -> ":smile:"
        if (core.endsWith(':') && core.length > 2) {
          const emojiName = core.slice(1, -1)
          const emojiEntry = EMOJI_BY_NAME.get(emojiName)
          if (emojiEntry) {
            const emojiHtmlRaw = `<span class="hs-mc-emoji" title=":${escapeHtml(emojiName)}:">${emojiEntry.emoji}</span>`
            if (emojiOverlay && pendingStack) {
              const itemMods = pendingMods.slice()
              const itemHue = pendingHue
              pendingMods = []
              pendingHue = null
              pendingStack.items.push({ kind: 'overlay', raw: emojiHtmlRaw, mods: itemMods, hue: itemHue })
              pendingWhitespace = ''
              continue
            }
            _flushStackToResult()
            if (pendingWhitespace) {
              result.push(pendingWhitespace)
              pendingWhitespace = ''
            }
            const startMods = pendingMods.slice()
            const startHue = pendingHue
            pendingMods = []
            pendingHue = null
            pendingStack = { items: [{ kind: 'base', raw: emojiHtmlRaw, mods: startMods, hue: startHue }] }
            continue
          }
        }
      }
      // Check for Unicode emoji — treat as stackable base
      if (UNICODE_EMOJI_RE.test(word)) {
        _flushStackToResult()
        if (pendingWhitespace) {
          result.push(pendingWhitespace)
          pendingWhitespace = ''
        }
        const emojiHtmlRaw = `<span class="hs-mc-emoji">${escapeHtml(word)}</span>`
        const startMods = pendingMods.slice()
        const startHue = pendingHue
        pendingMods = []
        pendingHue = null
        pendingStack = { items: [{ kind: 'base', raw: emojiHtmlRaw, mods: startMods, hue: startHue }] }
        continue
      }
      // Blocked emote whose URL didn't resolve in this context (removed from set,
      // wrong channel, foreign personal emote, etc.) — still render the blocked
      // box (2px dashed outline) instead of leaking the raw name as text. Matches
      // by exact name, so only emotes the user actually blocked are boxed.
      if (blockedEmoteNames.has(word)) {
        _flushStackToResult()
        pendingMods = []
        pendingHue = null
        if (pendingWhitespace) {
          result.push(pendingWhitespace)
          pendingWhitespace = ''
        }
        const dn = escapeHtml(word)
        result.push(
          `<span class="hs-mc-emote-wrapper hs-state-blocked" data-emote-name="${dn}" data-state="blocked" data-source="heatsync"><img src="${HS_TRANSPARENT_PX}" alt="${dn}" title="${dn}" class="hs-mc-emote hs-emote-blocked" style="width:var(--hs-emote-size,32px);height:var(--hs-emote-size,32px)" data-emote-name="${dn}" data-state="blocked" data-source="heatsync"></span>`,
        )
        continue
      }
      // Text - flush stack and add text. Drop any pending mods/hue (they had no anchor).
      _flushStackToResult()
      pendingMods = []
      pendingHue = null
      if (pendingWhitespace) {
        result.push(pendingWhitespace)
        pendingWhitespace = ''
      }
      // Color @mentions — always hoverable for profile cards. Unknown users
      // resolve a color asynchronously (mentionColor) instead of flat white.
      // Skipped when the caller (computeMessageText) is about to run
      // highlightMentionsInHtml over this output anyway — see skipMentions
      // doc comment on this function's signature for why a double-wrap here
      // is a real (not theoretical) blank-username bug.
      if (!skipMentions && word.startsWith('@') && word.length > 1) {
        const name = word
          .slice(1)
          .replace(/[,.:!?]+$/, '')
          .toLowerCase()
        const color =
          typeof mentionColor === 'function' ? mentionColor(name) : sanitizeColor(knownColors.get(name) || '#fff')
        result.push(
          `<a href="https://heatsync.org/user/${encodeURIComponent(name)}" target="_blank" rel="noopener noreferrer" class="hs-mc-user hs-mc-mention" data-username="${name}" style="color:${color};font-weight:bold">${word}</a>`,
        )
      } else if (linksEnabled && LINK_RE.test(word)) {
        // Validate URL protocol before creating link (block javascript:, data:, etc.)
        const hasProtocol = /^https?:\/\//i.test(word)
        const fullUrl = hasProtocol ? word : `https://${word}`
        if (/^https?:\/\//i.test(fullUrl)) {
          // word arrives PRE-ESCAPED (every caller runs escapeHtml first — see
          // the raw push in the else branch below). Escaping again turned a
          // url's &amp; into &amp;amp;: corrupted href params + visible &amp;
          // in the link text. Entities inside an href attr decode correctly.
          result.push(`<a href="${fullUrl}" target="_blank" rel="noopener noreferrer" class="hs-mc-link">${word}</a>`)
        } else {
          result.push(word)
        }
      } else {
        result.push(word)
      }
    }
  }

  // Flush any remaining stack
  _flushStackToResult()
  if (pendingWhitespace) {
    result.push(pendingWhitespace)
  }

  return result.join('')
}

// Render an emote stack (base + overlays)
function renderEmoteStack(stack) {
  if (stack.overlays.length === 0) {
    return stack.base
  }
  const overlayHtml = stack.overlays
    .map((o) =>
      // Strip any stale cached inline width from the overlay wrapper. The snap
      // measures the outer stack element (not the wrapper) and caches that against
      // the overlay URL — applying it as wAttr constrains the wrapper to the base
      // emote's width. With place-items:center the oversized img then bleeds left,
      // making the overlay visually appear before the base. Strip it so the wrapper
      // always sizes to the img's intrinsic width naturally.
      o
        .replace(/ style="width:\d+(?:\.\d+)?px"/, '')
        .replace('class="hs-mc-emote ', 'class="hs-mc-emote hs-mc-overlay-emote '),
    )
    .join('')
  const count = stack.overlays.length + 1
  // Reserve the stack's inline advance BEFORE any member decodes: the stack
  // sizes to its widest member, and without a reservation the row's text
  // re-wraps when a lazy overlay materializes width (worst with an emoji
  // base: the box jumps from glyph-width to overlay-width \u2014 the reported
  // "chat goes jank on emoji + overlay combos"). min-width, not width, so a
  // first-sighting member (no cached measurement yet) can still grow the box
  // once; hsSnapEmoteBox then pins the exact integer width on load.
  let _reserve = 0
  const _urlRe = /data-emote-url="([^"]+)"/g
  for (const html of [stack.base, overlayHtml]) {
    let m
    while ((m = _urlRe.exec(html))) {
      const w = _hsEmoteBoxW.get(m[1].replace(/&amp;/g, '&'))
      if (w > _reserve) _reserve = w
    }
    _urlRe.lastIndex = 0
  }
  const _resAttr = _reserve ? ` style="min-width:${_reserve}px"` : ''
  return `<span class="hs-mc-emote-stack" data-stack-count="${count}" title="expand"${_resAttr}><span class="hs-mc-emote-stack-emotes">${stack.base}${overlayHtml}</span><span class="hs-mc-stack-collapse" title="collapse">\u00d7</span><span class="hs-mc-stack-block-all" title="block all">\u2298</span></span>`
}

export {
  _buildChannelEmoteCache,
  blockedEmoteFallback,
  bumpEmoteFrecency,
  channelEmoteCaches,
  deriveStaticEmoteSrc,
  detectEmoteSource,
  dropEmoteFromAllSenders,
  emoteCache,
  ensureHsEmoteIdleObserver,
  getEmoteState,
  getSenderEmotes,
  hsSwapRowEmotesForIdle,
  inventoryEmotes,
  loadEmoteFrecency,
  loadSenderEmoteSets,
  lookupEmote,
  lookupEmoteRenderOrder,
  lookupEmoteWithOverlay,
  lookupOwnedEmote,
  mergeSenderEmotes,
  processEmotes,
  reapHsIdleEmoteRows,
  removedEmoteFallback,
  replaceSenderEmotes,
  scheduleHsEmoteIdleSweep,
  senderEmoteSets,
  staticEmoteSrc,
  sweepHsEmoteIdleRows,
  teardownHsEmoteIdleGate,
  unbumpEmoteFrecency,
  viewerPersonalEmotes,
  zeroWidthFromAnyCache,
}
