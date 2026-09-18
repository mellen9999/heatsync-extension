// gifs.js — the picker's third tab.
//
// Same corpus, same grid, same keyboard as heatsync.org's gifs tab, because it
// is the same fetch layer: src/lib/gif-search-remote.js is the site's file,
// byte for byte (scripts/sync-site-copies.sh). The only seam is the origin —
// a root-relative /api/gifs/... inside a twitch.tv page asks TWITCH for our
// gifs.
//
// Nothing here talks to giphy or tenor. The search is a request to heatsync and
// only the IMAGE comes from the provider CDN, which is what their terms ask for
// and the reason no keystroke ever leaves us. The three host pages we inject
// into (twitch, kick, youtube) send no img-src, so the tiles load directly and
// the extension's own manifest CSP never enters into it — that one governs
// popup.html, and the picker does not live there.
//
// AT MOST ONE ANIMATED GIF, EVER. Twenty-four animated gifs decoding at once is
// the difference between a picker and a space heater, and the overlay runs on
// top of a live video player. Giphy serves a still off the same id, the server
// hands us both urls, so the grid paints stills and swaps exactly the tile the
// reader is pointing at. Tenor has no equally reliable still and the payload
// says so by repeating the animated url — the two providers are not symmetric
// and pretending otherwise would hide the cost.

const HS_GIF_ORIGIN = 'https://heatsync.org'
const HS_GIF_CAP = 24 // hard ceiling, independent of what the server sends
const HS_GIF_EAGER = 12 // fetched immediately; the rest ride loading="lazy"
// Its OWN key, never the emote MRU: that list holds emote NAMES resolved
// against the emote maps at render time, and a gif id in it would resolve to
// nothing and silently shrink the recents row.
const HS_GIF_RECENT_KEY = 'hs-mc-recent-gifs'
const HS_GIF_RECENT_CAP = 12

let hsGifSearcher = null
let hsGifRows = []
let hsGifLibrary = null
let hsGifBusy = false
let hsGifError = null
let hsGifQuery = ''
let hsGifSel = -1
let hsGifAnimatedTile = null
// "normal mode" is the search input going readOnly, not the input losing focus
// — see hsGifPanelKey.
let hsGifMode = 'insert'
let hsGifSearchTimer = null

function hsGifSearch() {
  if (!hsGifSearcher) hsGifSearcher = createGifSearch({ base: HS_GIF_ORIGIN })
  return hsGifSearcher
}

function hsGifGrid() {
  return document.getElementById('hs-mc-gif-grid')
}

function hsLoadRecentGifs() {
  try {
    const raw = JSON.parse(localStorage.getItem(HS_GIF_RECENT_KEY) || '[]')
    return Array.isArray(raw) ? raw.map(normalizeGif).filter(Boolean) : []
  } catch {
    return []
  }
}

function hsRecordRecentGif(g) {
  try {
    const list = [g, ...hsLoadRecentGifs().filter((x) => x.id !== g.id)].slice(0, HS_GIF_RECENT_CAP)
    localStorage.setItem(HS_GIF_RECENT_KEY, JSON.stringify(list))
  } catch {
    // A full or blocked localStorage costs the reader their recents, never the pick.
  }
}

/** The tab's markup. Built with the panel, like every other tab. */
function hsGifTabHtml() {
  return `<div class="hs-mc-tab-content hs-mc-gif-tab" id="hs-mc-tab-gifs" style="display: none; flex-direction: column;">
        <div class="hs-mc-picker-header">
          <div class="hs-mc-search-wrap">
            <svg class="hs-mc-search-icon" width="14" height="14" viewBox="0 0 20 20"><path fill="#000" d="M13.74 12.33l4.04 4.04a1 1 0 01-1.42 1.42l-4.04-4.04a7 7 0 111.42-1.42zM9 14A5 5 0 109 4a5 5 0 000 10z"/></svg>
            <input type="text" id="hs-mc-gif-search" placeholder="${escapeHtml(t('mc_gif_search_placeholder'))}" autocomplete="off" spellcheck="false">
          </div>
        </div>
        <div class="hs-mc-picker-scroll hs-mc-gif-grid" id="hs-mc-gif-grid"></div>
        <div class="hs-mc-gif-mode" id="hs-mc-gif-mode"></div>
      </div>`
}

function hsGifTiles() {
  const grid = hsGifGrid()
  return grid ? [...grid.querySelectorAll('.hs-mc-gif')] : []
}

/**
 * At most one animated tile on screen. The previous one goes back to its still,
 * which is a plain src write — the image is already decoded and cached.
 */
function hsSetGifAnimated(tile) {
  if (hsGifAnimatedTile === tile) return
  const prev = hsGifAnimatedTile?.querySelector('img')
  if (prev?.dataset.still) prev.src = prev.dataset.still
  hsGifAnimatedTile = tile
  const img = tile?.querySelector('img')
  if (img?.dataset.animated) img.src = img.dataset.animated
}

/**
 * `animate` is off by default, and that is the whole perf contract.
 *
 * Every render selects a tile so Enter has a target without any navigation —
 * so a render-time animation would fire once per keystroke batch, for a gif
 * nobody has looked at yet. Nothing moves until the reader points at it: hover,
 * or an arrow/hjkl press they actually made.
 */
function hsSetGifSelection(i, animate) {
  const tiles = hsGifTiles()
  if (!tiles.length) {
    hsGifSel = -1
    return
  }
  hsGifSel = Math.max(0, Math.min(tiles.length - 1, i))
  tiles.forEach((tile, n) => {
    if (n === hsGifSel) tile.dataset.sel = '1'
    else delete tile.dataset.sel
  })
  const sel = tiles[hsGifSel]
  sel.scrollIntoView({ block: 'nearest' })
  if (animate) hsSetGifAnimated(sel)
}

/** Columns read off the live grid, so it stays right at every overlay width. */
function hsGifCols() {
  const grid = hsGifGrid()
  if (!grid) return 1
  const tmpl = getComputedStyle(grid).gridTemplateColumns
  return Math.max(1, tmpl && tmpl !== 'none' ? tmpl.split(' ').length : 1)
}

/**
 * Status line + empty state. An empty library is OUR cold start, not a bad
 * query — saying "no results" blames the reader for it.
 */
function hsGifStatusHtml(rows) {
  if (hsGifBusy) return `<div class="hs-mc-gif-status">${escapeHtml(t('mc_gif_searching'))}</div>`
  if (hsGifError) {
    const msg =
      hsGifError.status === 429
        ? t('mc_gif_rate_limited', [String(Math.max(1, Math.ceil(((hsGifError.resetAt || 0) - Date.now()) / 1000)))])
        : t('mc_gif_failed')
    return `<div class="hs-mc-gif-status">${escapeHtml(msg)}</div>`
  }
  if (rows.length) {
    return `<div class="hs-mc-gif-status">${escapeHtml(t('mc_gif_status', [String(rows.length)]))}</div>`
  }
  return ''
}

function hsGifEmptyHtml() {
  let msg
  if (hsGifLibrary?.state === 'empty') msg = t('mc_gif_library_empty')
  else if (hsGifQuery && hsGifLibrary?.state === 'building')
    msg = t('mc_gif_library_building', [String(hsGifLibrary.indexed ?? 0)])
  else if (hsGifQuery) msg = t('mc_gif_no_results')
  else msg = t('mc_gif_type_to_search')
  return `<div class="hs-mc-picker-empty">${escapeHtml(msg)}</div>`
}

function hsGifTileHtml(g, i) {
  const still = escapeHtml(g.preview)
  const animated = escapeHtml(g.animated)
  // The first screenful is worth a real fetch; the tail is lazy. The grid is
  // attached to the panel before this runs — a DETACHED loading="lazy" image
  // never starts its fetch at all, hidden or not.
  const load =
    i < HS_GIF_EAGER ? `src="${still}" fetchpriority="high"` : `src="${still}" loading="lazy" fetchpriority="low"`
  const label = g.label ? `<span class="hs-mc-gif-cap">${escapeHtml(g.label)}</span>` : ''
  return `<button type="button" class="hs-mc-gif" role="option" tabindex="-1" data-idx="${i}" title="${escapeHtml(g.label || 'gif')}"><img alt="" decoding="async" data-still="${still}" data-animated="${animated}" ${load}>${label}</button>`
}

function hsRenderGifs() {
  const grid = hsGifGrid()
  if (!grid) return
  const rows = hsGifRows.slice(0, HS_GIF_CAP)
  const tiles = rows.map(hsGifTileHtml).join('')
  grid.innerHTML = hsGifStatusHtml(rows) + (rows.length || hsGifBusy ? '' : hsGifEmptyHtml()) + tiles
  grid.setAttribute('role', 'listbox')
  hsGifAnimatedTile = null
  // A fresh render always offers a target for Enter — the common path is type,
  // then Enter, with no navigation at all.
  if (rows.length) hsSetGifSelection(hsGifSel < 0 ? 0 : hsGifSel, false)
  else hsGifSel = -1
}

function hsSetGifMode(mode) {
  hsGifMode = mode
  const input = document.getElementById('hs-mc-gif-search')
  if (input) input.readOnly = mode === 'normal'
  const line = document.getElementById('hs-mc-gif-mode')
  // An unannounced mode is a bug report.
  if (line) line.textContent = mode === 'normal' ? t('mc_gif_mode_normal') : t('mc_gif_mode_insert')
}

/**
 * Insert the direct media url — byte for byte what twitch's own gif keyboard
 * puts on the wire, and what every host chat already renders inline.
 *
 * Closes the panel, unlike an emote pick: chat renders one embed per message,
 * so rapid-fire has no meaning and a panel over the composer just hides what
 * you are about to send. The composer stays up, because the reader is mid-send.
 */
function hsPickGif(g) {
  if (!g) return
  hsRecordRecentGif(g)
  closeEmotePickerPanel({ keepInput: true })
  mcQuoteToInput(g.url)
}

/**
 * Two stale guards, not one. The query check covers a fast typist; the tab
 * check covers someone who switched tabs mid-flight.
 */
function hsRunGifSearch(q) {
  hsGifQuery = q
  if (!q) {
    hsGifSearch().abort()
    hsGifBusy = false
    hsGifError = null
    const recents = hsLoadRecentGifs()
    // Opening the picker costs no network while there are recents to redraw.
    hsGifRows = recents
    hsGifSel = recents.length ? 0 : -1
    hsRenderGifs()
    if (!recents.length) void hsLoadGifTop()
    return
  }
  hsGifBusy = true
  hsGifError = null
  hsRenderGifs() // status flips to "searching…", tiles stay put
  hsGifSearch()
    .search(q, GIF_PAGE_SIZE)
    .then(({ gifs, library }) => {
      if (hsGifQuery !== q || pickerTab !== 'gifs') return
      hsGifRows = gifs
      hsGifLibrary = library
      hsGifBusy = false
      hsGifSel = gifs.length ? 0 : -1
      hsRenderGifs()
    })
    .catch((err) => {
      if (err?.name === 'AbortError' || hsGifQuery !== q || pickerTab !== 'gifs') return
      hsGifBusy = false
      hsGifError = err
      hsGifRows = []
      hsRenderGifs()
    })
}

/** The empty-box listing, fetched once per open when there are no recents. */
async function hsLoadGifTop() {
  hsGifBusy = true
  hsRenderGifs()
  try {
    const { gifs, library } = await hsGifSearch().search('', GIF_PAGE_SIZE)
    if (pickerTab !== 'gifs' || hsGifQuery) return
    hsGifRows = gifs
    hsGifLibrary = library
  } catch (err) {
    if (err?.name !== 'AbortError') hsGifError = err
  } finally {
    hsGifBusy = false
    if (pickerTab === 'gifs' && !hsGifQuery) hsRenderGifs()
  }
}

/**
 * FOCUS NEVER LEAVES THE SEARCH INPUT, and that is not a style choice.
 *
 * type-to-focus.js yanks focus to the composer on any printable key and bails
 * only while an INPUT is focused. Park the caret on a grid tile and every
 * letter is stolen before this listener runs. So normal mode is the input going
 * readOnly: still an INPUT, still focused, so that guard keeps bailing, and a
 * key that slips past cannot corrupt the query.
 *
 * The listener is on the PANEL in the bubble phase, so it beats the document's
 * picker-Escape handler and never sees a composer key at all.
 */
function hsGifPanelKey(e) {
  if (pickerTab !== 'gifs') return
  const k = e.key
  const own = () => {
    e.preventDefault()
    e.stopPropagation()
  }

  if (k === 'Escape') {
    if (hsGifMode === 'insert') {
      own()
      hsSetGifMode('normal')
    }
    // In normal mode the document handler closes the picker, as it always has.
    return
  }
  if (hsGifMode === 'normal' && (k === 'i' || k === 'a' || k === '/')) {
    own()
    hsSetGifMode('insert')
    return
  }
  const tiles = hsGifTiles()
  if (k === 'Enter') {
    if (!tiles.length) return
    own()
    hsPickGif(hsGifRows[hsGifSel >= 0 ? hsGifSel : 0])
    return
  }
  // Arrows work in both modes; the vim letters only where they are not text.
  if (/^[hjklgG]$/.test(k) && hsGifMode !== 'normal') return
  const next = nextGridIndex(hsGifSel, k, { count: tiles.length, cols: hsGifCols() })
  if (next === null) return
  own()
  hsSetGifSelection(next, true)
}

/**
 * Wire the tab. The grid is a fresh element on every panel rebuild, so its
 * listeners cannot stack; the panel is not, so its keydown is guarded by a
 * per-context token the same way the emote click delegation is.
 */
function hsWireGifTab(picker) {
  const input = document.getElementById('hs-mc-gif-search')
  const grid = hsGifGrid()
  if (!input || !grid) return

  cleanup.addEventListener(
    input,
    'input',
    (e) => {
      cleanup.clearTimeout(hsGifSearchTimer)
      const q = e.target.value.trim()
      hsGifSearchTimer = cleanup.setTimeout(() => hsRunGifSearch(q), 200)
    },
    'mc-gif-search',
  )

  cleanup.addEventListener(
    grid,
    'click',
    (e) => {
      const tile = e.target.closest('.hs-mc-gif')
      if (!tile) return
      e.stopPropagation()
      hsPickGif(hsGifRows[Number(tile.dataset.idx)])
    },
    'mc-gif-pick',
  )

  // pointerenter does not bubble, so the hover swap rides pointerover.
  cleanup.addEventListener(grid, 'pointerover', (e) => hsSetGifAnimated(e.target.closest('.hs-mc-gif')), 'mc-gif-hover')
  cleanup.addEventListener(grid, 'pointerleave', () => hsSetGifAnimated(null), 'mc-gif-unhover')
  // A real <button> steals focus on mousedown, and the whole keyboard model
  // depends on the search input keeping it.
  cleanup.addEventListener(
    grid,
    'mousedown',
    (e) => {
      if (e.target.closest('.hs-mc-gif')) e.preventDefault()
    },
    'mc-gif-nofocus',
  )

  if (picker._hsGifKeyCtx !== _HS_PICKER_CLICK_CTX) {
    picker._hsGifKeyCtx = _HS_PICKER_CLICK_CTX
    cleanup.addEventListener(picker, 'keydown', hsGifPanelKey, 'mc-gif-keys')
  }
}

/**
 * Leaving the tab. The in-flight request goes on the floor and the one animated
 * tile stops — a hidden grid that is still decoding a gif is pure heat.
 */
function hsLeaveGifTab() {
  cleanup.clearTimeout(hsGifSearchTimer)
  hsGifSearch().abort()
  hsGifBusy = false
  hsSetGifAnimated(null)
  hsSetGifMode('insert')
}

/** Called every time the tab becomes the visible one, built or cached. */
function hsOnGifTabShown() {
  hsSetGifMode('insert')
  const input = document.getElementById('hs-mc-gif-search')
  if (input) input.focus()
  // Recents redraw from storage; only a cold reader spends a request.
  hsRunGifSearch(input?.value.trim() || '')
}

// Exported for the tests, stripped by the bundler — every module here lands in
// one shared scope, so nothing imports this at runtime.
export {
  HS_GIF_CAP,
  HS_GIF_EAGER,
  HS_GIF_RECENT_KEY,
  hsGifEmptyHtml,
  hsGifStatusHtml,
  hsGifTabHtml,
  hsGifTileHtml,
  hsLeaveGifTab,
  hsLoadRecentGifs,
  hsOnGifTabShown,
  hsRecordRecentGif,
  hsSetGifAnimated,
  hsWireGifTab,
}
