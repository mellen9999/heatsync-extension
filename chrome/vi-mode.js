/**
 * Vi mode for chat input
 *
 * Vim-like single-line editing for Twitch/Kick/multichat chat inputs.
 * Matches cmdchamp's vi mode: motions, operators, counts, f/F/t/T, undo, yank/paste.
 * Default off — toggled via heatsync settings panel.
 */
;(() => {
  const DEBUG = false
  const log = DEBUG ? console.log.bind(console, '[hs-vi]') : () => {}

  // Lifecycle controller — abort() tears down ALL listeners
  const lifecycle = new AbortController()
  const { signal } = lifecycle
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true })

  // Re-injection guard. Firefox re-injects content scripts into already-open
  // tabs on extension reload/AMO update WITHOUT a page unload, so the previous
  // context's window-level keydown listener (below) survives — no pagehide
  // ever fires to abort it. Two live instances each keep their own `mode`,
  // so one keypress runs twice (e.g. `k` dispatches ArrowUp AND types). Abort
  // the prior instance the moment this one loads: exactly one vi context owns
  // the keyboard at a time. Mirrors multichat's MC_WIRE_CTX takeover.
  try {
    window.__hsViLifecycle?.abort()
  } catch (_) {}
  window.__hsViLifecycle = lifecycle

  // Chat input selectors
  const INPUT_SELECTORS = [
    '[data-a-target="chat-input"]', // Twitch (contenteditable)
    'div.editor-input', // Kick (contenteditable)
    '.chat-input textarea', // Kick fallback
    'yt-live-chat-text-input-field-renderer div#input[contenteditable]', // YouTube
    '#hs-mc-input', // Multichat
  ]

  // --- State ---
  let enabled = false
  let mode = 'insert'
  let cursor = 0
  let count = ''
  let operator = null // pending: 'd', 'c', 'y'
  let pendingCmd = null // pending: 'f', 'F', 't', 'T', 'r', 'g'
  let lastFind = null // { type, char }
  let register = ''
  let undoStack = []
  const redoStack = []
  let lastEdit = null // { keys: [], beforeText, beforeCursor } for . repeat
  let recording = null // in-progress edit recording
  let activeEl = null
  let changing = false // inside a c-family delete (cc/s/S/C/c+motion) — the
  // transient empty must not trigger multichat's hide-on-empty (insert mode
  // follows immediately). Read via window.__hsViChanging below.

  // multichat's hideInputBar consults this before hiding an empty composer
  window.__hsViChanging = () => changing

  // multichat just auto-hid the composer (any path: empty-on-input, the
  // post-send retry timer, the window-focus reconciler). Let go immediately —
  // the focusout detach below is 150ms behind, and a printable key pressed in
  // that gap is swallowed as a vi command on an invisible composer instead of
  // reaching multichat's type-to-reveal handler.
  window.__hsViDetachNow = (el) => {
    if (!el || el === activeEl) detach()
  }

  // Run the delete phase of a change command with hide-on-empty suppressed.
  function changeDelete(fn) {
    changing = true
    try {
      fn()
    } finally {
      changing = false
    }
  }

  // --- DOM helpers ---

  function isCE(el) {
    return el && (el.isContentEditable || el.getAttribute('contenteditable') === 'true')
  }

  function getTextNodes(el) {
    const nodes = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      nodes.push(node)
      node = walker.nextNode()
    }
    return nodes
  }

  function findNodeAt(nodes, pos) {
    let remaining = pos
    for (const node of nodes) {
      if (remaining <= node.length) return { node, offset: remaining }
      remaining -= node.length
    }
    const last = nodes[nodes.length - 1]
    return last ? { node: last, offset: last.length } : null
  }

  function isAtom(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    if (node.tagName === 'IMG') return true
    if (node.contentEditable === 'false') return true
    // Overlay-emote stacks: one indivisible unit so h/l, x, db, dw, c-motions
    // all walk over and delete the whole stack (base + overlays) at once.
    const cl = node.classList
    if (cl?.contains('hs-input-stack') || cl?.contains('input-emote-stack')) return true
    return false
  }

  function getContentNodes(el) {
    const result = []
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.length > 0) result.push({ node: child, type: 'text', length: child.length })
        } else if (isAtom(child)) {
          result.push({ node: child, type: 'atom', length: 1 })
        } else if (child.childNodes.length) {
          walk(child)
        }
      }
    }
    walk(el)
    return result
  }

  function findContentAt(nodes, pos) {
    let remaining = pos
    for (const entry of nodes) {
      if (remaining < entry.length) return { entry, offset: remaining }
      remaining -= entry.length
    }
    const last = nodes[nodes.length - 1]
    return last ? { entry: last, offset: last.length } : null
  }

  function getVirtualText(el) {
    const nodes = getContentNodes(el)
    return nodes.map((e) => (e.type === 'atom' ? '\uFFFC' : e.node.textContent)).join('')
  }

  function getTextSlice(el, vStart, vEnd) {
    const cnodes = getContentNodes(el)
    let result = '',
      vPos = 0
    for (const e of cnodes) {
      const eEnd = vPos + e.length
      if (eEnd <= vStart) {
        vPos = eEnd
        continue
      }
      if (vPos >= vEnd) break
      if (e.type === 'text') {
        const s = Math.max(0, vStart - vPos)
        const end = Math.min(e.length, vEnd - vPos)
        result += e.node.textContent.slice(s, end)
      } else if (e.node.tagName === 'IMG') {
        result += e.node.alt || ''
      } else {
        // Stack span: join child img alts with spaces so yank+paste round-trips
        // back to a re-renderable text form ("TriHard ApuApustaja0").
        const imgs = e.node.querySelectorAll('img')
        const parts = []
        imgs.forEach((img) => {
          parts.push(img.alt || '')
        })
        result += parts.join(' ') || e.node.textContent || ''
      }
      vPos = eEnd
    }
    return result
  }

  // --- Adapter functions ---

  function getText(el) {
    if (!el) return ''
    if (!isCE(el)) return el.value || ''
    let text = ''
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent
      else if (node.tagName === 'IMG') text += node.alt || ''
      else text += node.textContent || ''
    }
    return text
  }

  function getLen(el) {
    return isCE(el) ? getVirtualText(el).length : (el.value || '').length
  }

  function getCursorPos(el) {
    if (!el) return 0
    if (isCE(el)) {
      const sel = window.getSelection()
      if (!sel.rangeCount) return 0
      const range = sel.getRangeAt(0)
      const cnodes = getContentNodes(el)
      let vPos = 0
      for (const entry of cnodes) {
        if (entry.type === 'text') {
          if (entry.node === range.startContainer) return vPos + range.startOffset
        } else {
          const parent = entry.node.parentNode
          if (range.startContainer === parent) {
            const idx = Array.from(parent.childNodes).indexOf(entry.node)
            if (range.startOffset <= idx) return vPos
            if (range.startOffset === idx + 1) return vPos + 1
          }
        }
        vPos += entry.length
      }
      return vPos
    }
    return el.selectionStart || 0
  }

  function setCursorPos(el, pos) {
    if (!el) return
    pos = Math.max(0, Math.min(pos, getLen(el)))
    if (isCE(el)) {
      const cnodes = getContentNodes(el)
      if (!cnodes.length) return
      const loc = findContentAt(cnodes, pos)
      if (!loc) return
      const sel = window.getSelection()
      const range = document.createRange()
      if (loc.entry.type === 'text') {
        range.setStart(loc.entry.node, loc.offset)
      } else {
        if (loc.offset === 0) range.setStartBefore(loc.entry.node)
        else range.setStartAfter(loc.entry.node)
      }
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    } else {
      el.setSelectionRange(pos, pos)
    }
  }

  function selectRange(el, start, end) {
    if (!el) return
    const len = getLen(el)
    start = Math.max(0, Math.min(start, len))
    end = Math.max(0, Math.min(end, len))
    if (isCE(el)) {
      const cnodes = getContentNodes(el)
      if (!cnodes.length) return
      const s = findContentAt(cnodes, start)
      const e = findContentAt(cnodes, end)
      if (!s || !e) return
      const sel = window.getSelection()
      const range = document.createRange()
      if (s.entry.type === 'text') {
        range.setStart(s.entry.node, s.offset)
      } else {
        if (s.offset === 0) range.setStartBefore(s.entry.node)
        else range.setStartAfter(s.entry.node)
      }
      if (e.entry.type === 'text') {
        range.setEnd(e.entry.node, e.offset)
      } else {
        if (e.offset === 0) range.setEndBefore(e.entry.node)
        else range.setEndAfter(e.entry.node)
      }
      sel.removeAllRanges()
      sel.addRange(range)
    } else {
      el.setSelectionRange(start, end)
    }
  }

  function deleteText(el, start, end) {
    if (!el || start >= end) return
    if (isCE(el)) {
      selectRange(el, start, end)
      document.execCommand('delete', false)
    } else {
      const v = el.value
      el.value = v.slice(0, start) + v.slice(end)
      el.setSelectionRange(start, start)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  function insertText(el, pos, text) {
    if (!el || !text) return
    if (isCE(el)) {
      el.focus()
      if (getContentNodes(el).length) {
        setCursorPos(el, pos)
      } else {
        // empty CE: no content nodes for setCursorPos to anchor a range to,
        // and the composer may be blurred (nothing anchors the document
        // selection there) — collapse a selection into the element itself
        // so execCommand inserts here instead of wherever a stale page
        // selection was left.
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      if (!document.execCommand('insertText', false, text)) {
        el.textContent = (el.textContent || '') + text
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
    } else {
      setCursorPos(el, pos)
      const v = el.value
      el.value = v.slice(0, pos) + text + v.slice(pos)
      el.setSelectionRange(pos + text.length, pos + text.length)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  function replaceAll(el, text) {
    if (!el) return
    if (isCE(el)) {
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
      if (text) document.execCommand('insertText', false, text)
      else document.execCommand('delete', false)
    } else {
      el.value = text
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  // --- Undo ---

  // Delegate to the shared UndoManager on input._undoManager (installed by
  // multichat input init). Vi's 'u' / Ctrl+R thereby step through the same
  // stack as Ctrl+Z — emote chips survive vi undo (the old text-only stack
  // would have flattened them on restore).
  function pushUndo(_el) {
    // No-op: UndoManager auto-captures on input events. Vi mutations use
    // execCommand which fires input events, so captures happen naturally.
  }

  function popUndo(el) {
    const mgr = el?._undoManager
    if (!mgr) {
      if (!undoStack.length) return
      redoStack.push({ text: getText(el), cursor })
      const s = undoStack.pop()
      replaceAll(el, s.text)
      cursor = s.cursor
      syncCursor(el)
      return
    }
    if (!mgr.undo()) return
    cursor = getCursorPos(el)
    syncCursor(el)
  }

  function popRedo(el) {
    const mgr = el?._undoManager
    if (!mgr) {
      if (!redoStack.length) return
      undoStack.push({ text: getText(el), cursor })
      const s = redoStack.pop()
      replaceAll(el, s.text)
      cursor = s.cursor
      syncCursor(el)
      return
    }
    if (!mgr.redo()) return
    cursor = getCursorPos(el)
    syncCursor(el)
  }

  // --- Word motions ---

  function charClass(ch) {
    if (!ch) return -1
    if (/\s/.test(ch)) return 0
    if (/\w/.test(ch)) return 1
    return 2
  }

  function moveW(text, pos, n) {
    for (let i = 0; i < n; i++) {
      if (pos >= text.length) break
      const cc = charClass(text[pos])
      while (pos < text.length && charClass(text[pos]) === cc) pos++
      while (pos < text.length && charClass(text[pos]) === 0) pos++
    }
    return pos
  }

  function moveB(text, pos, n) {
    for (let i = 0; i < n; i++) {
      if (pos <= 0) break
      pos--
      while (pos > 0 && charClass(text[pos]) === 0) pos--
      const cc = charClass(text[pos])
      while (pos > 0 && charClass(text[pos - 1]) === cc) pos--
    }
    return pos
  }

  function moveE(text, pos, n) {
    for (let i = 0; i < n; i++) {
      if (pos >= text.length - 1) break
      pos++
      while (pos < text.length - 1 && charClass(text[pos]) === 0) pos++
      const cc = charClass(text[pos])
      while (pos < text.length - 1 && charClass(text[pos + 1]) === cc) pos++
    }
    return pos
  }

  // --- WORD motions (space-delimited, not word-class) ---

  function moveWW(text, pos, n) {
    for (let i = 0; i < n; i++) {
      if (pos >= text.length) break
      while (pos < text.length && !/\s/.test(text[pos])) pos++
      while (pos < text.length && /\s/.test(text[pos])) pos++
    }
    return pos
  }

  function moveBB(text, pos, n) {
    for (let i = 0; i < n; i++) {
      if (pos <= 0) break
      pos--
      while (pos > 0 && /\s/.test(text[pos])) pos--
      while (pos > 0 && !/\s/.test(text[pos - 1])) pos--
    }
    return pos
  }

  function moveEE(text, pos, n) {
    for (let i = 0; i < n; i++) {
      if (pos >= text.length - 1) break
      pos++
      while (pos < text.length - 1 && /\s/.test(text[pos])) pos++
      while (pos < text.length - 1 && !/\s/.test(text[pos + 1])) pos++
    }
    return pos
  }

  // --- Find char motions ---

  function findCharMotion(text, pos, char, dir, before, n) {
    let p = pos
    for (let i = 0; i < n; i++) {
      let found = -1
      if (dir > 0) {
        for (let j = p + 1; j < text.length; j++) {
          if (text[j] === char) {
            found = j
            break
          }
        }
      } else {
        for (let j = p - 1; j >= 0; j--) {
          if (text[j] === char) {
            found = j
            break
          }
        }
      }
      if (found === -1) return pos
      p = found
    }
    if (before) p -= dir
    return p
  }

  // --- Resolve motion ---

  function resolveMotion(text, pos, key, n, char) {
    switch (key) {
      case 'h':
        return Math.max(0, pos - n)
      case 'l':
        return Math.min(Math.max(0, text.length - 1), pos + n)
      case 'w':
        return moveW(text, pos, n)
      case 'W':
        return moveWW(text, pos, n)
      case 'b':
        return moveB(text, pos, n)
      case 'B':
        return moveBB(text, pos, n)
      case 'e':
        return moveE(text, pos, n)
      case 'E':
        return moveEE(text, pos, n)
      case '0':
        return 0
      case '$':
        return Math.max(0, text.length - 1)
      case '^': {
        const m = text.match(/^\s*/)
        return m ? m[0].length : 0
      }
      case 'f':
        return findCharMotion(text, pos, char, 1, false, n)
      case 'F':
        return findCharMotion(text, pos, char, -1, false, n)
      case 't':
        return findCharMotion(text, pos, char, 1, true, n)
      case 'T':
        return findCharMotion(text, pos, char, -1, true, n)
      default:
        return pos
    }
  }

  // --- Cursor sync ---

  function syncCursor(el) {
    if (!el) return
    // Clear atom cursor highlights
    if (isCE(el))
      el.querySelectorAll('.hs-vi-cursor').forEach((n) => {
        n.classList.remove('hs-vi-cursor')
      })
    const len = getLen(el)
    if (mode === 'normal') {
      cursor = Math.max(0, Math.min(cursor, Math.max(0, len - 1)))
      if (len > 0) {
        if (isCE(el)) {
          const cnodes = getContentNodes(el)
          const loc = findContentAt(cnodes, cursor)
          if (loc && loc.entry.type === 'atom') {
            loc.entry.node.classList.add('hs-vi-cursor')
          }
        }
        selectRange(el, cursor, cursor + 1)
      } else {
        setCursorPos(el, 0)
      }
    } else {
      cursor = Math.max(0, Math.min(cursor, len))
      setCursorPos(el, cursor)
    }
    updateVisual()
    // Settled empty in normal mode (Escape on empty, dd/x to empty, undo) =
    // "done here" — hand multichat the auto-hide signal a keyboard-only flow
    // can never produce (no blur ever comes). Change-operators (cc/s/S) never
    // land here: mode is already 'insert' when their syncCursor runs. The
    // hook no-ops when auto-hide is off or the element isn't the composer.
    if (enabled && mode === 'normal' && len === 0) {
      window.__hsViComposerEmpty?.(el)
      // The hook may have auto-hidden + blurred the composer. Detach NOW —
      // waiting for the 150ms focusout timer leaves a window where the next
      // printable hits vi's hidden-composer fallback instead of multichat's
      // type-to-reveal (which focuses and types into a visible composer).
      if (document.activeElement !== el) detach()
    }
  }

  // --- Cheatsheet ---

  let cheatsheetEl = null

  function showCheatsheet(el) {
    if (cheatsheetEl) {
      hideCheatsheet()
      return
    }
    cheatsheetEl = document.createElement('div')
    cheatsheetEl.id = 'hs-vi-cheatsheet'
    Object.assign(cheatsheetEl.style, {
      position: 'fixed',
      bottom: '80px',
      right: '12px',
      background: '#000',
      color: '#fff',
      border: '1px solid #000',
      borderRadius: '6px',
      padding: '8px 10px',
      fontFamily: 'monospace',
      fontSize: '11px',
      lineHeight: '1.5',
      zIndex: '10000',
      maxWidth: '420px',
      whiteSpace: 'pre',
      boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
    })
    cheatsheetEl.textContent =
      'hl move  kj history  wb/WBE word  0$^ line  gg/G ends\n' +
      'fFtT+char find  ;, repeat find  [num]cmd repeat\n' +
      'x/X del char  dw/db/de/dd del  D del→end\n' +
      'cw/cb/ce/cc change  C change→end  s/S subst\n' +
      'yw/yb/ye/yy yank  p/P paste  r replace  ~ case\n' +
      'i/a/I/A insert  u undo  Ctrl+R redo  . repeat  ? help'
    document.body.appendChild(cheatsheetEl)
    // Auto-dismiss on any key
    const dismiss = () => {
      hideCheatsheet()
      document.removeEventListener('keydown', dismiss, { capture: true })
    }
    setTimeout(() => document.addEventListener('keydown', dismiss, { capture: true }), 100)
  }

  function hideCheatsheet() {
    if (cheatsheetEl) {
      cheatsheetEl.remove()
      cheatsheetEl = null
    }
  }

  // --- Normal mode visual: red border on input ---

  let styleInjected = false
  function injectStyle() {
    if (styleInjected) return
    styleInjected = true
    const s = document.createElement('style')
    // .hs-vi-normal keeps the red border — the site matches it, and that parity
    // is the point. The block cursor does not: it was translucent yellow with a
    // 2px radius, which is three house rules at once (yellow is warn, the
    // palette has no translucency, everything is square). It is a cursor, so it
    // takes the cursor invert, solid — same as heatsync.org.
    s.textContent = `.hs-vi-normal { outline: 2px solid #f00 !important; outline-offset: 0 !important; } #hs-mc-input-wrap:has(> .hs-vi-normal) { overflow: visible !important; } .hs-vi-cursor { background: #ff8700; color: #000; border-radius: 0; }`
    document.head.appendChild(s)
  }

  function updateVisual() {
    if (!activeEl) return
    if (enabled && mode === 'normal') {
      activeEl.classList.add('hs-vi-normal')
    } else {
      activeEl.classList.remove('hs-vi-normal')
    }
  }

  // --- Mode transitions ---

  function enterNormal(el) {
    mode = 'normal'
    count = ''
    operator = null
    pendingCmd = null
    const len = getLen(el)
    if (cursor > 0 && cursor >= len) cursor = len - 1
    cursor = Math.max(0, cursor)
    syncCursor(el)
    log('→ NORMAL, cursor:', cursor)
  }

  function enterInsert(el, pos) {
    mode = 'insert'
    count = ''
    operator = null
    pendingCmd = null
    if (pos !== undefined) cursor = pos
    // Start recording for . repeat
    recording = { beforeText: getText(el), beforeCursor: cursor, afterCursor: null }
    syncCursor(el)
    log('→ INSERT, cursor:', cursor)
  }

  // --- Get accumulated count ---

  function getCount() {
    const n = count ? parseInt(count, 10) : 1
    count = ''
    return Math.max(1, Math.min(n, 9999))
  }

  // --- Execute operator on motion range ---

  function executeOperator(el, text, from, to, motionKey) {
    const op = operator
    operator = null
    // Record for . repeat (d and c operations)
    const beforeText = text
    const beforeCursor = cursor

    let start, end
    if (to >= from) {
      start = from
      // Inclusive end for: e $ l f F t T
      end = 'eE$lftTF'.includes(motionKey) ? to + 1 : to
    } else {
      start = to
      end = from
    }

    if (start >= end) return

    register = isCE(el) ? getTextSlice(el, start, end) : text.slice(start, end)

    switch (op) {
      case 'd': {
        pushUndo(el)
        deleteText(el, start, end)
        cursor = start
        const newLen = getLen(el)
        if (cursor >= newLen && newLen > 0) cursor = newLen - 1
        if (newLen === 0) cursor = 0
        syncCursor(el)
        lastEdit = { beforeText, afterText: getText(el), beforeCursor, afterCursor: cursor }
        break
      }
      case 'c':
        pushUndo(el)
        changeDelete(() => deleteText(el, start, end))
        cursor = start
        enterInsert(el, start)
        break
      case 'y':
        // Just yank
        break
    }
  }

  // --- Keydown handler ---

  function handleKeyDown(e) {
    if (!enabled || !activeEl) return
    // Skip synthetic events we dispatched (prevent infinite recursion)
    if (e._hsVi) return
    // Ctrl+R = redo in normal mode
    if (e.ctrlKey && e.key === 'r' && mode === 'normal') {
      e.preventDefault()
      e.stopImmediatePropagation()
      popRedo(activeEl)
      return
    }
    // Don't intercept other modifier combos (Ctrl, Alt, Meta)
    if (e.ctrlKey || e.metaKey || e.altKey) return

    if (mode === 'normal') {
      handleNormalMode(e)
    } else {
      handleInsertMode(e)
    }
  }

  function handleInsertMode(e) {
    // Only intercept Escape in insert mode
    if (e.key === 'Escape') {
      // A composer overlay owns this Escape (autocomplete dropdown, emote
      // picker, ctx menu, armed reply) — pass it through so the overlay's
      // own handler closes it. Intercepting here starved them all AND
      // dumped the user into normal mode mid-message, where the next
      // letters silently ran as motions instead of typing.
      try {
        if (window.__hsEscOwned?.()) return
      } catch (_) {}
      e.preventDefault()
      e.stopImmediatePropagation()
      // Finalize . repeat recording
      if (recording) {
        const afterText = getText(activeEl)
        if (afterText !== recording.beforeText) {
          lastEdit = {
            beforeText: recording.beforeText,
            afterText,
            beforeCursor: recording.beforeCursor,
            afterCursor: getCursorPos(activeEl),
          }
        }
        recording = null
      }
      // Read current cursor position from DOM
      cursor = getCursorPos(activeEl)
      if (cursor > 0) cursor-- // vim: back one on escape
      enterNormal(activeEl)
    }
    // Everything else passes through (Tab, Enter, typing, etc.)
  }

  function blockEvent(e) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  function handleNormalMode(e) {
    const el = activeEl
    const text = isCE(el) ? getVirtualText(el) : el.value || ''
    const len = text.length
    const key = e.key

    // Let Enter through for chat submission
    if (key === 'Enter') {
      // Switch to insert mode after send
      mode = 'insert'
      updateVisual()
      return
    }

    // IME composition (accented/CJK compose sequences) is never a vim motion —
    // key.length === 1 doesn't catch 'Dead'/'Process' or an in-progress
    // composition, so they fell through to blockEvent and got eaten.
    if (key === 'Dead' || key === 'Process' || e.isComposing) return

    // Overlay-owned Escape (dropdown/picker/ctx/reply) closes the overlay —
    // same pass-through as insert mode; blocking it here stranded open
    // overlays whenever the user was in normal mode.
    if (key === 'Escape' && !pendingCmd && !operator) {
      try {
        if (window.__hsEscOwned?.()) return
      } catch (_) {}
    }

    // Empty composer → there's nothing to navigate or edit, so a printable key
    // can only mean "start typing this message" — never a normal-mode motion.
    // Without this, an empty composer left in normal mode (after Escape, or the
    // ~150ms window before focusout detaches on auto-hide) ate the key: e.g. `f`
    // began a find-char instead of typing an `f`. Drop to insert AND type the
    // char ourselves — must still blockEvent so the key can't leak to other
    // handlers (browser find, link-hint extensions, host-page `f`/`t` shortcuts)
    // and fire e.g. link hints alongside the typed character.
    if (len === 0 && !pendingCmd && !operator && !count && key.length === 1) {
      blockEvent(e)
      mode = 'insert'
      updateVisual()
      insertText(el, cursor, key)
      cursor = getCursorPos(el)
      return
    }

    // Block everything else from reaching other handlers
    blockEvent(e)

    // --- Pending char commands (f/F/t/T/r after operator or standalone) ---
    if (pendingCmd) {
      const cmd = pendingCmd
      pendingCmd = null

      if (key === 'Escape') return

      // g prefix: only gg is valid
      if (cmd === 'g') {
        if (key === 'g') {
          if (operator) {
            executeOperator(el, text, cursor, 0, '0')
          } else {
            cursor = 0
            syncCursor(el)
          }
        }
        return
      }

      if (key.length !== 1) return

      // r: replace char
      if (cmd === 'r') {
        if (cursor < len) {
          pushUndo(el)
          selectRange(el, cursor, cursor + 1)
          if (isCE(el)) {
            document.execCommand('insertText', false, key)
          } else {
            el.value = text.slice(0, cursor) + key + text.slice(cursor + 1)
            el.dispatchEvent(new Event('input', { bubbles: true }))
          }
          syncCursor(el)
        }
        return
      }

      // f/F/t/T char motion
      const n = getCount()
      lastFind = { type: cmd, char: key }
      const newPos = resolveMotion(text, cursor, cmd, n, key)

      if (operator) {
        executeOperator(el, text, cursor, newPos, cmd)
      } else {
        cursor = newPos
        syncCursor(el)
      }
      return
    }

    // --- Count prefix ---
    if ((key >= '1' && key <= '9') || (key === '0' && count.length > 0)) {
      count += key
      return
    }

    const n = getCount()

    // --- Operator pending: waiting for motion ---
    if (operator) {
      // dd, cc, yy: whole line
      if (key === operator) {
        switch (operator) {
          case 'd':
            pushUndo(el)
            register = getText(el)
            replaceAll(el, '')
            cursor = 0
            syncCursor(el)
            break
          case 'c':
            pushUndo(el)
            register = getText(el)
            changeDelete(() => replaceAll(el, ''))
            cursor = 0
            enterInsert(el, 0)
            break
          case 'y':
            register = getText(el)
            break
        }
        operator = null
        return
      }

      // Motion after operator
      if ('hlwbeWBE0$^'.includes(key)) {
        const newPos = resolveMotion(text, cursor, key, n)
        executeOperator(el, text, cursor, newPos, key)
        return
      }
      if ('fFtT'.includes(key)) {
        pendingCmd = key
        return
      }
      if (key === 'g') {
        pendingCmd = 'g'
        return
      }

      // Invalid motion: cancel operator
      operator = null
      return
    }

    // --- Mode switches ---
    switch (key) {
      case 'i':
        enterInsert(el, cursor)
        return
      case 'a':
        enterInsert(el, Math.min(cursor + 1, len))
        return
      case 'I':
        enterInsert(el, 0)
        return
      case 'A':
        enterInsert(el, len)
        return
      case 's':
        pushUndo(el)
        if (cursor < len) {
          const dc = Math.min(n, len - cursor)
          register = isCE(el) ? getTextSlice(el, cursor, cursor + dc) : text.slice(cursor, cursor + dc)
          changeDelete(() => deleteText(el, cursor, cursor + dc))
        }
        enterInsert(el, cursor)
        return
      case 'S':
        pushUndo(el)
        register = getText(el)
        changeDelete(() => replaceAll(el, ''))
        enterInsert(el, 0)
        return
      case 'C':
        pushUndo(el)
        if (cursor < len) {
          register = isCE(el) ? getTextSlice(el, cursor, len) : text.slice(cursor)
          changeDelete(() => deleteText(el, cursor, len))
        }
        enterInsert(el, cursor)
        return
    }

    // --- Motions ---
    if ('hlwbeWBE0$^'.includes(key)) {
      cursor = resolveMotion(text, cursor, key, n)
      syncCursor(el)
      return
    }

    // Find motions
    if ('fFtT'.includes(key)) {
      pendingCmd = key
      return
    }

    // Repeat find
    if (key === ';' && lastFind) {
      cursor = resolveMotion(text, cursor, lastFind.type, n, lastFind.char)
      syncCursor(el)
      return
    }
    if (key === ',' && lastFind) {
      const reversed = { f: 'F', F: 'f', t: 'T', T: 't' }[lastFind.type]
      cursor = resolveMotion(text, cursor, reversed, n, lastFind.char)
      syncCursor(el)
      return
    }

    // g prefix (gg)
    if (key === 'g') {
      pendingCmd = 'g'
      return
    }

    // G: end of line
    if (key === 'G') {
      cursor = Math.max(0, len - 1)
      syncCursor(el)
      return
    }

    // --- Operators ---
    if ('dcy'.includes(key)) {
      operator = key
      return
    }

    // --- Edit commands ---
    switch (key) {
      case 'x': {
        if (cursor < len) {
          pushUndo(el)
          const dc = Math.min(n, len - cursor)
          register = isCE(el) ? getTextSlice(el, cursor, cursor + dc) : text.slice(cursor, cursor + dc)
          deleteText(el, cursor, cursor + dc)
          const nl = getLen(el)
          if (cursor >= nl && nl > 0) cursor = nl - 1
          if (nl === 0) cursor = 0
          syncCursor(el)
        }
        return
      }
      case 'X': {
        if (cursor > 0) {
          pushUndo(el)
          const dc = Math.min(n, cursor)
          register = isCE(el) ? getTextSlice(el, cursor - dc, cursor) : text.slice(cursor - dc, cursor)
          deleteText(el, cursor - dc, cursor)
          cursor -= dc
          syncCursor(el)
        }
        return
      }
      case 'D': {
        if (cursor < len) {
          pushUndo(el)
          register = isCE(el) ? getTextSlice(el, cursor, len) : text.slice(cursor)
          deleteText(el, cursor, len)
          const nl = getLen(el)
          if (cursor >= nl && nl > 0) cursor = nl - 1
          if (nl === 0) cursor = 0
          syncCursor(el)
        }
        return
      }
      case 'r': {
        pendingCmd = 'r'
        return
      }
      case '~': {
        if (cursor < len && text[cursor] !== '\uFFFC') {
          pushUndo(el)
          const end = Math.min(cursor + n, len)
          let toggled = ''
          for (let i = cursor; i < end; i++) {
            if (text[i] === '\uFFFC') break
            const ch = text[i]
            toggled += ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()
          }
          if (toggled) {
            selectRange(el, cursor, cursor + toggled.length)
            if (isCE(el)) {
              document.execCommand('insertText', false, toggled)
            } else {
              el.value = text.slice(0, cursor) + toggled + text.slice(cursor + toggled.length)
              el.dispatchEvent(new Event('input', { bubbles: true }))
            }
            cursor = Math.min(cursor + toggled.length, Math.max(0, getLen(el) - 1))
            syncCursor(el)
          }
        }
        return
      }
      case 'p': {
        if (register) {
          pushUndo(el)
          const pos = Math.min(cursor + 1, len)
          let content = ''
          for (let i = 0; i < n; i++) content += register
          insertText(el, pos, content)
          cursor = pos + content.length - 1
          syncCursor(el)
        }
        return
      }
      case 'P': {
        if (register) {
          pushUndo(el)
          let content = ''
          for (let i = 0; i < n; i++) content += register
          insertText(el, cursor, content)
          cursor = cursor + content.length - 1
          syncCursor(el)
        }
        return
      }
      case 'u': {
        popUndo(el)
        return
      }
      case '.': {
        // Repeat last edit: replay the text transformation
        if (!lastEdit) return
        pushUndo(el)
        // Apply the same diff: find what was at beforeCursor, replace with the change
        const currentText = getText(el)
        const { beforeText, afterText } = lastEdit
        // Compute the inserted text (what was added in the edit)
        // Simple diff: find common prefix/suffix between before and after
        let prefixLen = 0
        while (
          prefixLen < beforeText.length &&
          prefixLen < afterText.length &&
          beforeText[prefixLen] === afterText[prefixLen]
        )
          prefixLen++
        let suffixLen = 0
        while (
          suffixLen < beforeText.length - prefixLen &&
          suffixLen < afterText.length - prefixLen &&
          beforeText[beforeText.length - 1 - suffixLen] === afterText[afterText.length - 1 - suffixLen]
        )
          suffixLen++
        const deletedLen = beforeText.length - prefixLen - suffixLen
        const inserted = afterText.slice(prefixLen, afterText.length - suffixLen)
        // Apply at current cursor position
        const delStart = cursor
        const delEnd = Math.min(cursor + deletedLen, currentText.length)
        if (delEnd > delStart) deleteText(el, delStart, delEnd)
        if (inserted) insertText(el, delStart, inserted)
        cursor = delStart + inserted.length
        if (cursor > 0) cursor--
        const nl = getLen(el)
        if (cursor >= nl && nl > 0) cursor = nl - 1
        syncCursor(el)
        return
      }
    }

    // j/k — chat history navigation (dispatch native arrow events)
    if (key === 'k' || key === 'j') {
      const arrowKey = key === 'k' ? 'ArrowUp' : 'ArrowDown'
      const evt = new KeyboardEvent('keydown', { key: arrowKey, code: arrowKey, bubbles: true })
      evt._hsVi = true
      el.dispatchEvent(evt)
      setTimeout(() => {
        cursor = getCursorPos(el)
        syncCursor(el)
      }, 50)
      return
    }

    // ? — show vi cheatsheet
    if (key === '?') {
      showCheatsheet(el)
      return
    }

    // Arrow keys
    if (key === 'ArrowLeft') {
      cursor = Math.max(0, cursor - n)
      syncCursor(el)
      return
    }
    if (key === 'ArrowRight') {
      cursor = Math.min(Math.max(0, len - 1), cursor + n)
      syncCursor(el)
      return
    }
    // ArrowUp/Down: dispatch native arrow for history
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const evt = new KeyboardEvent('keydown', { key, code: key, bubbles: true })
      evt._hsVi = true
      el.dispatchEvent(evt)
      setTimeout(() => {
        cursor = getCursorPos(el)
        syncCursor(el)
      }, 50)
      return
    }
  }

  // --- Settings ---

  function loadSettings() {
    // Try chrome.storage first (async), fallback to localStorage
    const api = (typeof browser !== 'undefined' && browser) || (typeof chrome !== 'undefined' && chrome)
    if (api?.storage?.sync) {
      Promise.resolve(api.storage.sync.get('ui_settings'))
        .then((result) => {
          if (result?.ui_settings) {
            const wasEnabled = enabled
            enabled = !!result.ui_settings.viMode
            if (enabled && !wasEnabled) onEnable()
            else if (!enabled && wasEnabled) onDisable()
            log('Settings loaded from storage, viMode:', enabled)
          }
        })
        .catch(() => {})
    }
    // Also check localStorage (sync fallback)
    try {
      const stored = localStorage.getItem('heatsync-extension-settings')
      if (stored) {
        const settings = JSON.parse(stored)
        enabled = !!settings.viMode
      }
    } catch (_) {}
  }

  function onEnable() {
    updateVisual()
  }

  function onDisable() {
    mode = 'insert'
    count = ''
    operator = null
    pendingCmd = null
    updateVisual()
  }

  // Listen for settings changes via postMessage (from heatsync-button.js)
  window.addEventListener(
    'message',
    (e) => {
      if (e.source !== window || e.origin !== location.origin) return
      if (e.data?.type === 'heatsync-settings-changed' && e.data.settings) {
        const wasEnabled = enabled
        enabled = !!e.data.settings.viMode
        if (enabled && !wasEnabled) onEnable()
        else if (!enabled && wasEnabled) onDisable()
      }
    },
    { signal },
  )

  // Listen for storage changes (Firefox + Chrome compatible)
  const viApi = (typeof browser !== 'undefined' && browser) || (typeof chrome !== 'undefined' && chrome)
  if (viApi?.storage?.onChanged) {
    const storageListener = (changes, area) => {
      // ui_settings lives in chrome.storage.sync, not local — watching 'local'
      // meant popup/other-tab viMode flips never reached vi-mode until reload.
      if (area === 'sync' && changes.ui_settings?.newValue) {
        const wasEnabled = enabled
        enabled = !!changes.ui_settings.newValue.viMode
        if (enabled && !wasEnabled) onEnable()
        else if (!enabled && wasEnabled) onDisable()
      }
    }
    viApi.storage.onChanged.addListener(storageListener)
    signal.addEventListener('abort', () => {
      viApi.storage.onChanged.removeListener(storageListener)
    })
  }

  // --- Input tracking ---

  function matchesInput(el) {
    if (!el) return false
    return INPUT_SELECTORS.some((sel) => {
      try {
        return el.matches(sel)
      } catch (_) {
        return false
      }
    })
  }

  function attach(el) {
    if (activeEl === el) return
    activeEl = el
    cursor = getCursorPos(el)
    mode = 'insert'
    undoStack = []
    count = ''
    operator = null
    pendingCmd = null
    log('Attached to', el.tagName, el.id || el.className)
  }

  function detach() {
    if (activeEl) activeEl.classList.remove('hs-vi-normal')
    activeEl = null
    mode = 'insert'
    count = ''
    operator = null
    pendingCmd = null
  }

  // --- Initialization ---

  function init() {
    injectStyle()
    loadSettings()

    // Keydown at capture phase on window — fires before all other handlers
    window.addEventListener('keydown', handleKeyDown, { capture: true, signal })

    // Track focus
    document.addEventListener(
      'focusin',
      (e) => {
        if (matchesInput(e.target)) attach(e.target)
      },
      { signal },
    )

    document.addEventListener(
      'focusout',
      (e) => {
        if (e.target === activeEl) {
          setTimeout(() => {
            if (document.activeElement !== activeEl) detach()
          }, 150)
        }
      },
      { signal },
    )

    // Try to find existing focused input
    for (const sel of INPUT_SELECTORS) {
      const el = document.querySelector(sel)
      if (el && document.activeElement === el) {
        attach(el)
        break
      }
    }

    log('vi-mode initialized, enabled:', enabled)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
