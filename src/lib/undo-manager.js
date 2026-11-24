// @ts-check
/**
 * Unified undo/redo for contenteditable input (extension port).
 *
 * Mirrors the website's UndoManager (client/utils/undo-manager.js):
 * snapshots input child DOM via cloneNode + cursor char-offset, restores
 * via replaceChildren. Per-keystroke + structural-op granularity.
 */

export class UndoManager {
  constructor(input, opts = {}) {
    this.input = input
    this.max = opts.max || 100
    this.stack = []
    this.index = -1
    this._suppress = false
    this.capture()
  }

  capture() {
    if (this._suppress) {
      this._suppress = false
      return
    }
    // Cheap check first: compare the live DOM directly against the last
    // snapshot (NodeList is array-like — _signatureMatch just needs
    // .length + indexing, no clone required to read it). Only pay for the
    // deep clone + cursor walk when the content actually changed.
    const liveChildren = this.input.childNodes
    if (this.index >= 0 && _signatureMatch(this.stack[this.index].children, liveChildren)) return
    const children = [...liveChildren].map((n) => n.cloneNode(true))
    const cursorOffset = this._getCharOffset()
    if (this.index < this.stack.length - 1) {
      this.stack.length = this.index + 1
    }
    this.stack.push({ children, cursorOffset })
    if (this.stack.length > this.max) {
      this.stack.shift()
    }
    this.index = this.stack.length - 1
  }

  undo() {
    if (this.index <= 0) return false
    this.index--
    this._restore(this.stack[this.index])
    return true
  }

  redo() {
    if (this.index >= this.stack.length - 1) return false
    this.index++
    this._restore(this.stack[this.index])
    return true
  }

  reset() {
    this.stack.length = 0
    this.index = -1
    this.capture()
  }

  _restore(snapshot) {
    this._suppress = true
    const clones = snapshot.children.map((n) => n.cloneNode(true))
    this.input.replaceChildren(...clones)
    this._reattachImgHandlers()
    this._setCharOffset(snapshot.cursorOffset)
    // marked: what came back is what was there, picks included (emote-refs keepPicksIn)
    this.input.dispatchEvent(Object.assign(new Event('input', { bubbles: true }), { hsUndo: true }))
  }

  _reattachImgHandlers() {
    for (const img of this.input.querySelectorAll('img.hs-input-emote, img.input-emote')) {
      img.addEventListener('error', () => {
        if (img.dataset.hsRetried) {
          img.replaceWith(document.createTextNode(img.alt || ''))
          return
        }
        img.dataset.hsRetried = '1'
        const bust = `${img.src + (img.src.includes('?') ? '&' : '?')}r=${Date.now()}`
        img.src = bust
      })
    }
  }

  _getCharOffset() {
    const sel = window.getSelection()
    if (!sel?.rangeCount) return 0
    const range = sel.getRangeAt(0)
    if (!this.input.contains(range.startContainer)) return 0
    let offset = 0
    const walker = document.createTreeWalker(this.input, NodeFilter.SHOW_ALL)
    let node = walker.nextNode()
    while (node) {
      if (node === range.startContainer) {
        if (node.nodeType === Node.TEXT_NODE) return offset + range.startOffset
        return offset
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += (node.textContent || '').length
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = /** @type {HTMLImageElement} */ (node)
        if (el.tagName === 'IMG' && el.alt) offset += el.alt.length
      }
      node = walker.nextNode()
    }
    return offset
  }

  _setCharOffset(target) {
    let offset = 0
    const walker = document.createTreeWalker(this.input, NodeFilter.SHOW_ALL)
    let node = walker.nextNode()
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const len = (node.textContent || '').length
        if (offset + len >= target) {
          const sel = window.getSelection()
          if (!sel) return
          const range = document.createRange()
          range.setStart(node, Math.max(0, Math.min(target - offset, len)))
          range.collapse(true)
          sel.removeAllRanges()
          sel.addRange(range)
          return
        }
        offset += len
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const img = /** @type {HTMLImageElement} */ (node)
        if (img.tagName === 'IMG' && img.alt) {
          const len = img.alt.length
          if (offset + len > target) {
            const sel = window.getSelection()
            if (!sel) return
            const range = document.createRange()
            range.setStartAfter(img)
            range.collapse(true)
            sel.removeAllRanges()
            sel.addRange(range)
            return
          }
          offset += len
        }
      }
      node = walker.nextNode()
    }
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(this.input)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

export function installUndoManager(input, opts) {
  if (input._undoManager) return input._undoManager
  const manager = new UndoManager(input, opts)
  input._undoManager = manager
  input.addEventListener('input', () => manager.capture())
  input.addEventListener(
    'keydown',
    (e) => {
      const isCmd = e.ctrlKey || e.metaKey
      if (!isCmd) return
      if (e.repeat) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        e.stopPropagation()
        if (e.shiftKey) manager.redo()
        else manager.undo()
      } else if (k === 'y') {
        e.preventDefault()
        e.stopPropagation()
        manager.redo()
      }
    },
    true,
  )
  return manager
}

function _signatureMatch(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i]
    if (x.nodeType !== y.nodeType) return false
    if (x.nodeType === Node.TEXT_NODE) {
      if (x.textContent !== y.textContent) return false
    } else if (x.nodeType === Node.ELEMENT_NODE) {
      if (x.tagName !== y.tagName) return false
      if (x.outerHTML !== y.outerHTML) return false
    }
  }
  return true
}
