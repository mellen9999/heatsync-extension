// ctx-menu — the ONE right-click menu every surface uses (chat rows, feed posts,
// emotes, emoji). `items` is an array of the string 'sep' or
// { label, fn, danger, good, disabled, key }.
//
// KEYBOARD AND SCREEN READER
// The menu is a real ARIA menu: role=menu with a name, role=menuitem rows (the
// ones that can't be used say aria-disabled), role=separator between groups.
// Focus is real focus, not a pretend highlight:
//
//   open    focus goes INTO the menu — onto the first item when it was opened
//           from the keyboard (opts.keyboard), onto the menu itself for a mouse
//           open, so nothing is lit under a pointer that is somewhere else
//   up/down move between items and wrap; home/end jump; hovering an item moves
//           focus to it, so exactly one row is ever lit
//   enter / space   use the focused item
//   1-9     use the nth usable item (the old numbered shortcuts, unchanged)
//   esc / tab       close
//   close   focus goes back to whatever held it before the menu opened
//
// Keys with ctrl/alt/meta are never the menu's: alt+1 jumps tab, and used to
// fire item 1 of an open menu on the way.

let hsCtxOpen = null // { dismiss, opener } of the menu on screen, so a new one closes it properly

function showHsCtxMenu(x, y, header, items, opts = {}) {
  // A menu opened over another keeps the ORIGINAL opener: by now focus is
  // inside the old menu, which is about to go.
  const prev = hsCtxOpen
  const opener = prev ? prev.opener : document.activeElement
  prev?.dismiss(false)
  const menu = document.createElement('div')
  Object.assign(menu, { id: 'hs-mc-msg-ctx', className: 'hs-mc-ctx', dir: HS_DIR(), tabIndex: -1 })
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', header ? t('mc_ctx_menu_for', [String(header)]) : t('mc_ctx_menu_aria'))
  menu.addEventListener('contextmenu', (e) => e.preventDefault())

  const entries = [] // {el, fn} every menuitem in DOM order; fn is null when it can't be used
  const usable = [] // the entries that can be used, numbered 1..9 from the top
  if (header) {
    const h = document.createElement('div')
    h.className = 'hs-mc-em-header'
    h.setAttribute('aria-hidden', 'true') // the menu's own name already says it
    h.textContent = header
    menu.appendChild(h)
  }
  for (const spec of items) {
    if (spec === 'sep') {
      const s = document.createElement('div')
      s.className = 'hs-mc-em-sep'
      s.setAttribute('role', 'separator')
      menu.appendChild(s)
      continue
    }
    const it = document.createElement('div')
    it.className =
      'hs-mc-em-item' +
      (spec.danger ? ' hs-mc-em-danger' : '') +
      (spec.good ? ' hs-mc-em-good' : '') +
      (spec.disabled ? ' hs-mc-em-disabled' : '')
    it.setAttribute('role', 'menuitem')
    it.tabIndex = -1
    if (spec.key) it.dataset.hsKey = spec.key
    const lab = document.createElement('span')
    lab.className = 'hs-mc-em-label'
    lab.textContent = spec.label
    it.appendChild(lab)
    const fn = !spec.disabled && spec.fn ? spec.fn : null
    if (!fn) it.setAttribute('aria-disabled', 'true')
    const entry = { el: it, fn }
    entries.push(entry)
    if (fn) {
      usable.push(entry)
      it.addEventListener('click', () => use(entry))
    }
    it.addEventListener('mouseenter', () => focusAt(entries.indexOf(entry)))
    menu.appendChild(it)
  }
  // Number top-down (key 1 is the first usable item, ascending downward). The
  // digit is a hint for the eye; the item's name for a screen reader is its
  // label, and the shortcut is declared properly.
  for (let i = 0; i < usable.length && i < 9; i++) {
    const { el } = usable[i]
    const k = document.createElement('span')
    k.className = 'hs-mc-em-kbd'
    k.setAttribute('aria-hidden', 'true')
    k.textContent = String(i + 1)
    el.appendChild(k)
    el.setAttribute('aria-keyshortcuts', String(i + 1))
  }

  document.body.appendChild(menu)
  menu.style.visibility = 'hidden'
  menu.style.left = '0px'
  menu.style.top = '0px'
  const mw = menu.offsetWidth,
    mh = menu.offsetHeight
  const vw = window.innerWidth,
    vh = window.innerHeight
  const flipX = x + mw + 8 > vw
  const flipY = y + mh + 8 > vh
  menu.style.left = `${flipX ? Math.max(4, x - mw) : Math.min(x, vw - mw - 4)}px`
  menu.style.top = `${flipY ? Math.max(4, y - mh) : Math.min(y, vh - mh - 4)}px`
  if (flipX) menu.classList.add('hs-mc-em-flip-x')
  if (flipY) menu.classList.add('hs-mc-em-flip-y')
  menu.style.visibility = ''

  let cur = -1 // index into entries of the focused item
  function focusAt(i) {
    if (!entries.length) return
    cur = ((i % entries.length) + entries.length) % entries.length
    try {
      entries[cur].el.focus({ preventScroll: true })
    } catch {}
  }
  function use(entry) {
    if (!entry.fn) return
    dismiss()
    try {
      entry.fn()
    } catch {}
  }
  // Focus goes in before anything else can happen: the keys below are only
  // heard because the menu is what holds focus.
  if (opts.keyboard && usable.length) focusAt(entries.indexOf(usable[0]))
  else {
    try {
      menu.focus({ preventScroll: true })
    } catch {}
  }

  function dismiss(restoreFocus = true) {
    menu.remove()
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', keyHandler, true)
    document.removeEventListener('contextmenu', outside, true)
    if (hsCtxOpen === handle) hsCtxOpen = null
    // Back to where the person was — before the item runs, so an item that
    // moves focus itself (composer, editor) still wins.
    if (restoreFocus && opener && opener !== document.body && opener.isConnected) {
      try {
        opener.focus({ preventScroll: true })
      } catch {}
    }
  }
  const handle = { dismiss, opener }
  hsCtxOpen = handle
  function outside(ev) {
    if (!menu.contains(ev.target)) dismiss()
  }
  function keyHandler(ev) {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return
    const k = ev.key
    if (k === 'Escape' || k === 'Tab') {
      ev.preventDefault()
      dismiss()
      return
    }
    let step = null
    if (k === 'ArrowDown') step = () => focusAt(cur + 1)
    else if (k === 'ArrowUp') step = () => focusAt(cur < 0 ? -1 : cur - 1)
    else if (k === 'Home') step = () => focusAt(0)
    else if (k === 'End') step = () => focusAt(-1)
    else if (k === 'Enter' || k === ' ') step = () => cur >= 0 && use(entries[cur])
    else if (k.length === 1 && k >= '1' && k <= '9' && usable[Number(k) - 1]) step = () => use(usable[Number(k) - 1])
    if (!step) return
    ev.preventDefault()
    ev.stopPropagation()
    ownKeyup(ev) // and its keyup — youtube toggles play on Space's keyup (overlay-keys.js)
    step()
  }
  setTimeout(() => {
    // dismissed (or replaced) inside the tick it opened in: nothing to listen for
    if (hsCtxOpen !== handle) return
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', keyHandler, true)
    document.addEventListener('contextmenu', outside, true)
  }, 0)
}
