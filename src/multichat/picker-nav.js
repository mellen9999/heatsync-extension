// picker-nav.js — the emote picker from the keyboard, and how the panel closes.
//
// THE MODEL
// Focus never leaves the search box (type-to-focus.js steals every printable key
// the moment an INPUT is not focused, so a tile can never hold DOM focus). The
// box is a WAI-ARIA combobox and the tile grid is its listbox: the tile under
// the keyboard cursor is aria-selected and named by aria-activedescendant.
//
//   ArrowDown          engage: the cursor lands on the first tile
//   arrows, Home, End  move it (once engaged; on an empty box they engage too,
//                      since there is no text to edit)
//   Enter              insert the tile, exactly as a click does; with a query
//                      typed and nothing engaged, the best match
//   typing, blur       let go of the cursor
//   Escape             close the panel and hand focus back to the composer
//
// It is the same grid for the main set and for search results (the search just
// re-renders the grid's contents), so one handler serves both.
//
// The cursor is --hs-sel (cyan), not white: white is where the POINTER is, cyan
// is where Enter will land, the split every other list in the overlay uses.

const HS_PICKER_TILE = '.hs-mc-picker-emote-wrap'
const HS_PICKER_NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

let _pickerCloseHandler = null
let hsPickerSel = null
let hsPickerOptSeq = 0
let hsPickerGridObs = null
// The cursor owns the scroll position until the reader scrolls by hand. A tile's box is its image's
// (an emote that has not loaded is a 28px stand-in), so a late image or a chunk filling in reflows
// the grid and can carry the tile out of view after the scroll that put it there. While this is
// set, any such reflow puts the tile back.
let hsPickerFollow = false
let hsPickerSizeObs = null

/**
 * The next row up (dir -1) or down (+1) from tile `cur`, as the tile whose
 * centre is nearest the current column. Tiles are told apart by their boxes, not
 * by index arithmetic: each section wraps on its own, so no fixed column count
 * is true across the whole grid.
 */
function hsPickerRowStep(count, cur, dir, rectAt) {
  const centreY = (i) => {
    const r = rectAt(i)
    return r.top + r.height / 2
  }
  const me = rectAt(cur)
  const half = me.height / 2
  const cx = me.left + me.width / 2
  const sameRow = (i, y) => Math.abs(centreY(i) - y) < half
  const myY = centreY(cur)
  let i = cur + dir
  while (i >= 0 && i < count && sameRow(i, myY)) i += dir
  if (i < 0 || i >= count) return cur
  const rowY = centreY(i)
  let best = i
  let bestDist = Infinity
  for (; i >= 0 && i < count && sameRow(i, rowY); i += dir) {
    const r = rectAt(i)
    const dist = Math.abs(r.left + r.width / 2 - cx)
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  return best
}

/**
 * Where the cursor goes. Pure: `rectAt(i)` ({left, top, width, height}) is all it
 * asks of the page. Clamps at the edges rather than wrapping, like the gifs grid.
 * Returns null for a key it does not own.
 */
function hsPickerNavTarget(count, cur, key, rectAt) {
  if (count <= 0 || !HS_PICKER_NAV_KEYS.has(key)) return null
  const last = count - 1
  if (cur < 0) return key === 'End' ? last : 0
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, cur - 1)
    case 'ArrowRight':
      return Math.min(last, cur + 1)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return hsPickerRowStep(count, cur, key === 'ArrowDown' ? 1 : -1, rectAt)
  }
}

/**
 * Chunks fill as they near the viewport, which is too late for a cursor that
 * moves faster than the observer reports (a held arrow key, End). Keep the
 * chunk holding `tile` and the one on either side of it filled; no tile means
 * the last chunk, which is where End is headed.
 */
function hsPickerFillAround(grid, tile) {
  const chunks = [...grid.querySelectorAll('.hs-mc-picker-chunk')]
  const at = tile ? chunks.indexOf(tile.closest('.hs-mc-picker-chunk')) : chunks.length - 1
  if (at < 0) return
  for (const c of [chunks[at - 1], chunks[at], chunks[at + 1]]) {
    if (c && !c.classList.contains('hs-mc-chunk-ready')) _fillChunk(c)
  }
}

/** Scroll the grid itself, never an ancestor, and clear the sticky section label. */
function hsPickerScrollTo(grid, tile) {
  if (tile === grid.querySelector(HS_PICKER_TILE)) {
    grid.scrollTop = 0
    return
  }
  const g = grid.getBoundingClientRect()
  const r = tile.getBoundingClientRect()
  const label = tile.closest('.hs-mc-picker-section')?.querySelector('.hs-mc-picker-section-header')
  const top = g.top + (label ? label.offsetHeight : 0)
  if (r.top < top) grid.scrollTop -= top - r.top
  else if (r.bottom > g.bottom) grid.scrollTop += r.bottom - g.bottom
}

/** Put the cursor on `tile` (null lets go of it). */
function hsPickerSelect(tile) {
  const input = document.getElementById('hs-mc-emote-search')
  if (hsPickerSel && hsPickerSel !== tile) hsPickerSel.setAttribute('aria-selected', 'false')
  hsPickerSel = tile
  if (!tile) {
    hsPickerFollow = false
    input?.removeAttribute('aria-activedescendant')
    return
  }
  const grid = document.getElementById('hs-mc-emote-grid')
  if (grid) hsPickerFillAround(grid, tile)
  tile.setAttribute('aria-selected', 'true')
  if (!tile.id) tile.id = `hs-mc-emote-opt-${++hsPickerOptSeq}`
  input?.setAttribute('aria-activedescendant', tile.id)
  if (grid) hsPickerScrollTo(grid, tile)
  hsPickerFollow = true
}

function hsPickerKey(e) {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
  const grid = document.getElementById('hs-mc-emote-grid')
  const input = e.currentTarget
  if (!grid || !input) return
  if (e.key === 'Enter') {
    // Nothing engaged: Enter takes the best match, but only once the grid shows
    // THIS query — inside the search debounce it still shows the last one.
    const query = input.value.toLowerCase().trim()
    const tile = hsPickerSel || (query && query === _mcSearchRenderedQuery ? grid.querySelector(HS_PICKER_TILE) : null)
    const img = tile?.querySelector('img')
    if (!img) return
    e.preventDefault()
    // the click is the whole insert path (paste, auto-add, unblock, remote add)
    img.click()
    return
  }
  if (!HS_PICKER_NAV_KEYS.has(e.key)) return
  if (!hsPickerSel && e.key !== 'ArrowDown' && input.value) return
  // End must find its tile before the observer would have filled that far
  if (e.key === 'End') hsPickerFillAround(grid, null)
  const tiles = [...grid.querySelectorAll(HS_PICKER_TILE)]
  const cur = hsPickerSel ? tiles.indexOf(hsPickerSel) : -1
  const next = hsPickerNavTarget(tiles.length, cur, e.key, (i) => tiles[i].getBoundingClientRect())
  if (next === null) return
  e.preventDefault()
  hsPickerSelect(tiles[next])
}

/**
 * The grid's contents were replaced (a search landed, a provider answered, load
 * more). Keep the combobox honest about whether there is a list, and keep the
 * cursor on the emote it was on when that emote is still there.
 */
function hsPickerGridChanged() {
  const grid = document.getElementById('hs-mc-emote-grid')
  const input = document.getElementById('hs-mc-emote-search')
  if (!grid || !input) return
  input.setAttribute('aria-expanded', grid.querySelector('[role="listbox"]') ? 'true' : 'false')
  // the list is a new element after every render; watch whichever one is on screen
  hsPickerSizeObs?.disconnect()
  const list = grid.firstElementChild
  if (list) hsPickerSizeObs?.observe(list)
  const was = hsPickerSel
  if (!was || grid.contains(was)) return
  hsPickerSel = null
  const name = was.dataset.name
  hsPickerSelect([...grid.querySelectorAll(HS_PICKER_TILE)].find((t) => t.dataset.name === name) || null)
}

function hsWirePickerNav(picker) {
  const input = picker.querySelector('#hs-mc-emote-search')
  const grid = picker.querySelector('#hs-mc-emote-grid')
  if (!input || !grid) return
  hsPickerSel = null
  cleanup.addEventListener(input, 'keydown', hsPickerKey, 'mc-picker-nav')
  cleanup.addEventListener(input, 'input', () => hsPickerSelect(null), 'mc-picker-nav-input')
  cleanup.addEventListener(input, 'blur', () => hsPickerSelect(null), 'mc-picker-nav-blur')
  if (hsPickerGridObs) cleanup.untrackObserver(hsPickerGridObs)
  hsPickerGridObs = cleanup.trackObserver(new MutationObserver(hsPickerGridChanged))
  hsPickerGridObs.observe(grid, { childList: true })
  if (hsPickerSizeObs) cleanup.untrackObserver(hsPickerSizeObs)
  hsPickerSizeObs = cleanup.trackObserver(
    new ResizeObserver(() => {
      if (hsPickerFollow && hsPickerSel?.isConnected) hsPickerScrollTo(grid, hsPickerSel)
    }),
  )
  for (const ev of ['wheel', 'pointerdown', 'touchmove']) {
    cleanup.addEventListener(grid, ev, () => (hsPickerFollow = false), `mc-picker-nav-${ev}`)
  }
  hsPickerGridChanged()
}

/** Opened from the keyboard: the reader is at the button, so put them in the box. */
function hsPickerFocusSearch() {
  const input = document.getElementById('hs-mc-emote-search')
  if (pickerTab === 'emotes' && input?.getClientRects().length) input.focus()
}

// ── close handlers ─────────────────────────────────────────────────────────
// cleanup.addEventListener wraps a handler, so the handler itself is not what
// sits on the document: taking it down means calling the remover
// cleanup.addEventListener hands back. (removeEventListener(handler) matched
// nothing, and a click + a keydown listener piled up on every open.)
let _pickerEscHandler = null
let _pickerCloseOff = null
let _pickerEscOff = null
let _pickerAttachTimer = null

/** Give the composer back to a reader who was in the panel — if there still is one. */
function hsFocusComposer() {
  if (!document.getElementById('hs-mc-inputbar')?.classList.contains('hs-hidden'))
    document.getElementById('hs-mc-input')?.focus()
}

/** Take down the document-level close handlers. */
function detachPickerCloseHandlers() {
  if (_pickerAttachTimer != null) cleanup.clearTimeout(_pickerAttachTimer)
  _pickerAttachTimer = null
  if (_pickerCloseOff) _pickerCloseOff()
  if (_pickerEscOff) _pickerEscOff()
  _pickerCloseHandler = null
  _pickerEscHandler = null
  _pickerCloseOff = null
  _pickerEscOff = null
}

/**
 * The one way to close the panel from code.
 *
 * Those document handlers self-remove when THEY close the picker, so anything
 * that closes it on its own has to take them down too — or the next Escape
 * still runs hideInputBar(), over a composer the reader is typing into. A gif
 * pick is the first close that does not go through them.
 *
 * `keepInput` is for exactly that case: the panel goes away, the composer does
 * not, because the reader is mid-send with a url already in the box.
 */
function closeEmotePickerPanel({ keepInput = false } = {}) {
  const picker = document.getElementById('hs-mc-emote-picker')
  if (!picker) return
  picker.classList.remove('visible')
  if (!keepInput) hideInputBar()
  stopPredictionPoll()
  detachPickerCloseHandlers()
}

function attachPickerCloseHandler(picker) {
  detachPickerCloseHandlers()
  _pickerAttachTimer = cleanup.setTimeout(() => {
    _pickerAttachTimer = null
    _pickerCloseHandler = (e) => {
      if (mcSignal?.aborted) return detachPickerCloseHandlers()
      if (!picker.contains(e.target) && !e.target.closest('#hs-mc-emote-btn')) closeEmotePickerPanel()
    }
    _pickerEscHandler = (e) => {
      if (e.key !== 'Escape') return
      if (mcSignal?.aborted) return detachPickerCloseHandlers()
      const inside = picker.contains(document.activeElement)
      closeEmotePickerPanel()
      if (inside) hsFocusComposer()
    }
    _pickerCloseOff = cleanup.addEventListener(document, 'click', _pickerCloseHandler, 'mc-picker-close')
    _pickerEscOff = cleanup.addEventListener(document, 'keydown', _pickerEscHandler, 'mc-picker-esc')
  }, 0)
}

// Exported for the tests, stripped by the bundler.
export {
  attachPickerCloseHandler,
  closeEmotePickerPanel,
  detachPickerCloseHandlers,
  hsPickerFocusSearch,
  hsPickerGridChanged,
  hsPickerKey,
  hsPickerNavTarget,
  hsPickerSelect,
  hsWirePickerNav,
}
