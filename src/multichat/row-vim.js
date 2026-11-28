// Visual mode (v) and hint mode (f / F), inside row mode (row-mode.js), the same contract as the
// site's client/vim/visual-mode.js and hint-mode.js.
//
//   v            start a selection at the cursor row; j k g G (with a count) stretch it, o swaps its ends
//   y            copy the text of every selected row        a   copy their permalinks
//   q            quote the first row                        b   bookmark them (feed posts)
//   m            mute their authors                         esc / v   leave, nothing done
//   f / F        letters over every link, name, emote and button; type one to click it
//                (F opens a link in a new tab); esc or any other key cancels
//
// Bulk mod actions are not here: delete / timeout / ban on a range is a footgun, same as the site.

const HINT_ALPHABET = 'fjdkslaghrueiwoqptyvncmxzb' // home row first
const HINT_SELECTOR = [
  '#hs-mc-messages a[href]',
  '#hs-mc-messages .hs-mc-user',
  '#hs-mc-messages .hs-mc-emote-wrapper',
  '#hs-mc-messages button',
  '.hs-mc-tab',
].join(',')
const VIS_CLASS = 'hs-mc-row-selected'

const _rowHint = { active: false, newTab: false, typed: '', targets: [], layer: null }
const _rowVisual = { active: false, anchor: null, count: '' }

/** n short labels: one letter while they fit, two after */
function rowHintLabels(n) {
  const a = HINT_ALPHABET.split('')
  if (n <= a.length) return a.slice(0, n)
  const out = []
  for (const x of a)
    for (const y of a) {
      out.push(x + y)
      if (out.length >= n) return out
    }
  return out
}

function _rowHintVisible(el) {
  const r = el.getBoundingClientRect()
  if (r.width <= 1 || r.height <= 1) return false
  return !(r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth)
}

function rowHintActive() {
  return _rowHint.active
}

/** @returns {boolean} whether any label went up (false: nothing to click on screen) */
function rowHintEnter(newTab) {
  rowHintExit()
  const els = [...document.querySelectorAll(HINT_SELECTOR)].filter(_rowHintVisible)
  // a target that wraps another is not the one you mean: the innermost wins
  const set = new Set(els)
  const leaves = els.filter((el) => !els.some((o) => o !== el && el.contains(o) && set.has(o)))
  if (!leaves.length) return false
  const labels = rowHintLabels(leaves.length)
  _rowHint.active = true
  _rowHint.newTab = !!newTab
  _rowHint.typed = ''
  const layer = document.createElement('div')
  layer.id = 'hs-hint-layer'
  _rowHint.targets = leaves.map((el, i) => {
    const r = el.getBoundingClientRect()
    const chip = document.createElement('span')
    chip.className = 'hs-hint'
    chip.textContent = labels[i]
    chip.style.left = `${Math.max(0, r.left)}px`
    chip.style.top = `${Math.max(0, r.top)}px`
    layer.appendChild(chip)
    return { el, label: labels[i], chip }
  })
  document.body.appendChild(layer)
  _rowHint.layer = layer
  return true
}

function rowHintExit() {
  if (!_rowHint.active) return
  _rowHint.active = false
  _rowHint.layer?.remove()
  _rowHint.layer = null
  _rowHint.targets = []
  _rowHint.typed = ''
}

function _rowHintFire(el, newTab) {
  const href = el.getAttribute?.('href') || el.closest?.('a[href]')?.getAttribute('href')
  if (newTab && href) {
    window.open(href, '_blank', 'noopener')
    return
  }
  el.click()
}

function _rowHintPaint() {
  for (const t of _rowHint.targets) {
    const on = t.label.startsWith(_rowHint.typed)
    t.chip.hidden = !on
    t.chip.textContent = ''
    if (on && _rowHint.typed) {
      const typed = document.createElement('span')
      typed.className = 'hs-hint-typed'
      typed.textContent = _rowHint.typed
      t.chip.append(typed, t.label.slice(_rowHint.typed.length))
    } else t.chip.textContent = t.label
  }
}

/**
 * A key while hints are up. Always consumed (the mode is modal).
 * @param {string} k
 * @param {() => void} [beforeFire] runs just before a target is clicked (row mode lets go of focus)
 */
function rowHintKey(k, beforeFire) {
  if (k === 'Escape') {
    rowHintExit()
    return true
  }
  if (k === 'Backspace') {
    _rowHint.typed = _rowHint.typed.slice(0, -1)
    _rowHintPaint()
    return true
  }
  if (k.length !== 1 || !HINT_ALPHABET.includes(k.toLowerCase())) {
    rowHintExit() // anything else cancels, so nobody is ever stuck
    return true
  }
  _rowHint.typed += k.toLowerCase()
  const exact = _rowHint.targets.find((t) => t.label === _rowHint.typed)
  if (exact) {
    const { el } = exact
    const newTab = _rowHint.newTab
    rowHintExit()
    beforeFire?.()
    _rowHintFire(el, newTab)
    return true
  }
  if (!_rowHint.targets.some((t) => t.label.startsWith(_rowHint.typed))) {
    rowHintExit()
    return true
  }
  _rowHintPaint()
  return true
}

// ── visual ──────────────────────────────────────────────────────────────

function rowVisualActive() {
  return _rowVisual.active
}

function rowVisualEnter(row) {
  _rowVisual.active = true
  _rowVisual.anchor = row
  _rowVisual.count = ''
}

function rowVisualExit() {
  if (!_rowVisual.active) return
  _rowVisual.active = false
  _rowVisual.anchor = null
  _rowVisual.count = ''
  for (const r of document.querySelectorAll(`.${VIS_CLASS}`)) r.classList.remove(VIS_CLASS)
}

/** the rows from the anchor to the cursor, either way round */
function rowVisualRange(rows, cursorRow) {
  let a = rows.indexOf(_rowVisual.anchor)
  const c = Math.max(0, rows.indexOf(cursorRow))
  if (a < 0) {
    _rowVisual.anchor = cursorRow // the anchor row was trimmed off the top
    a = c
  }
  return rows.slice(Math.min(a, c), Math.max(a, c) + 1)
}

function rowVisualPaint(rows, cursorRow) {
  const sel = new Set(rowVisualRange(rows, cursorRow))
  for (const r of rows) r.classList.toggle(VIS_CLASS, sel.has(r))
  return sel.size
}

function _rowAuthor(row) {
  const u = row.querySelector('.hs-mc-user:not(.hs-mc-reply-user)')
  const name = (u?.dataset?.username || u?.textContent || row.dataset?.msgUser || '').replace(/^@/, '').trim()
  return name ? { name: name.toLowerCase(), platform: u?.dataset?.platform || row.dataset?.msgPlatform || null } : null
}

/**
 * A key while visual mode is on. Always consumed.
 * @param {string} k
 * @param {{ rows: HTMLElement[], at: number, go: (i: number) => void, leave: () => void, say: (s: string) => void }} c
 */
function rowVisualKey(k, c) {
  const { rows, at, go, leave, say } = c
  const take = () => {
    const n = _rowVisual.count ? Number.parseInt(_rowVisual.count, 10) : 1
    _rowVisual.count = ''
    return Math.max(1, Math.min(n, 9999))
  }
  if (k === 'Escape' || k === 'v') {
    rowVisualExit()
    return true
  }
  if ((k >= '1' && k <= '9') || (k === '0' && _rowVisual.count)) {
    _rowVisual.count += k
    return true
  }
  if (k === 'j' || k === 'ArrowDown') return (go(at + take()), true)
  if (k === 'k' || k === 'ArrowUp') return (go(at - take()), true)
  if (k === 'g' || k === 'Home') return (go(0), true)
  if (k === 'G' || k === 'End') return (go(rows.length - 1), true)
  if (k === 'o') {
    const a = _rowVisual.anchor
    _rowVisual.anchor = rows[at]
    if (a) go(rows.indexOf(a))
    return true
  }
  const sel = rowVisualRange(rows, rows[at])
  if (k === 'y') {
    const text = sel
      .map((r) => _extractMcMsgText(r))
      .filter(Boolean)
      .join('\n')
    rowVisualExit()
    if (text)
      mcCopyToClipboard(
        text,
        sel.length > 1 ? t('mc_vis_copied_n', [String(sel.length)]) : t('mc_input_message_copied'),
      )
    else say(t('mc_vis_nothing'))
    return true
  }
  if (k === 'a') {
    const links = sel.map((r) => (r.dataset?.msgId && !r.dataset?.hsReplay ? buildRowPermalink(r) : '')).filter(Boolean)
    rowVisualExit()
    if (links.length) mcCopyToClipboard(links.join('\n'), t('mc_vis_links_n', [String(links.length)]))
    else say(t('mc_vis_no_links'))
    return true
  }
  if (k === 'q') {
    const first = sel[0]
    rowVisualExit()
    if (first?.dataset?.msgId && !first.dataset.hsReplay) {
      leave()
      startQuoteFromRow(first)
    } else say(t('mc_vis_nothing'))
    return true
  }
  if (k === 'b') {
    const ids = sel.map((r) => r._hsFeedMsg?.base36_id).filter(Boolean)
    rowVisualExit()
    if (ids.length && typeof feedBookmarkToggle === 'function') {
      for (const id of ids) feedBookmarkToggle(id)
      say(t('mc_vis_bookmarked', [String(ids.length)]))
    } else say(t('mc_vis_nothing'))
    return true
  }
  if (k === 'm') {
    const seen = new Set()
    const who = []
    for (const r of sel) {
      const a = _rowAuthor(r)
      if (!a || seen.has(`${a.platform}:${a.name}`)) continue
      seen.add(`${a.platform}:${a.name}`)
      if (typeof isUserMuted === 'function' && isUserMuted(a.name, a.platform)) continue // never un-mutes
      who.push(a)
    }
    rowVisualExit()
    if (who.length) {
      for (const a of who) _toggleMcMute(a.name, a.platform)
      say(t('mc_vis_muted', [String(who.length)]))
    } else say(t('mc_vis_nothing'))
    return true
  }
  return true // a stray key is swallowed; the selection stays
}
