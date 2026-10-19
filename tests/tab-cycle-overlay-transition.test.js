/**
 * Tab-cycle transitions between overlay and non-overlay matches
 * (insertCompletionWysiwyg, src/multichat/input.js).
 *
 * Regression anchor: "KAK, then wave + Tab Tab Tab — the first three matches
 * were overlays and stacked fine, the 4th (dankwave, non-overlay) dropped the
 * cycle: neither Tab nor Shift+Tab did anything after it."
 *
 * Freeing the cycling img from the stack left the caret stranded. The
 * separator check compared the next sibling against an exact nbsp, but the
 * overlay insert path leaves a PLAIN space there — so it inserted a second
 * separator IN FRONT of the existing one, and the caret (still sitting in the
 * old node) no longer had the chip as its previousSibling.
 * caretOnActiveCompletion then read false, and the next Tab tore the cycle
 * down and restarted on an empty word — i.e. did nothing, forever.
 *
 * The freed chip also landed flush against its former base (the separator was
 * only ever added on the right), and two touching chips are exactly what
 * unwrapStuckChips rewrites on the next input, yanking the caret backwards
 * between them.
 *
 * Carved out of the non-module content-script bundle and evaluated against a
 * minimal fake DOM (same rationale as tab-complete-stale / overlay-base-left;
 * jsdom/happy-dom isn't a repo dependency).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const EMOTES_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')

const carve = (src, startMarker, endMarker) => {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker)
  if (start === -1 || end === -1 || end <= start) throw new Error(`carve markers not found: ${startMarker}`)
  return src.slice(start, end)
}

// ─── minimal fake DOM ───────────────────────────────────────────────────────
// Only the surface these functions touch: sibling/parent links, classList,
// dataset, a comma-separated tag.class matcher for querySelector/closest, and
// a collapsed-selection stand-in.

const TEXT_NODE = 3
const ELEMENT_NODE = 1

class TextNode {
  constructor(text) {
    this.nodeType = TEXT_NODE
    this.textContent = text
    this.parentNode = null
  }
  get length() {
    return this.textContent.length
  }
  get nextSibling() {
    return sibling(this, 1)
  }
  get previousSibling() {
    return sibling(this, -1)
  }
  get parentElement() {
    return this.parentNode
  }
  remove() {
    this.parentNode?.removeChild(this)
  }
  replaceWith(node) {
    this.parentNode?.insertBefore(node, this)
    this.remove()
  }
}

class ElementNode {
  constructor(tag) {
    this.nodeType = ELEMENT_NODE
    this.tagName = tag.toUpperCase()
    this.childNodes = []
    this.parentNode = null
    this.dataset = {}
    this.attrs = {}
    this.style = {
      width: '',
      removeProperty(k) {
        this[k] = ''
      },
    }
    this._classes = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
    }
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean))
  }
  get className() {
    return [...this._classes].join(' ')
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE)
  }
  get firstElementChild() {
    return this.children[0] || null
  }
  get firstChild() {
    return this.childNodes[0] || null
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('')
  }
  set textContent(v) {
    this.childNodes.forEach((n) => {
      n.parentNode = null
    })
    this.childNodes = []
    if (v) this.appendChild(new TextNode(v))
  }
  get nextSibling() {
    return sibling(this, 1)
  }
  get previousSibling() {
    return sibling(this, -1)
  }
  get parentElement() {
    return this.parentNode
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v)
  }
  getAttribute(k) {
    return this.attrs[k] ?? null
  }
  addEventListener() {}
  focus() {}
  appendChild(node) {
    node.parentNode?.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  insertBefore(node, ref) {
    node.parentNode?.removeChild(node)
    node.parentNode = this
    const i = ref ? this.childNodes.indexOf(ref) : -1
    if (i === -1) this.childNodes.push(node)
    else this.childNodes.splice(i, 0, node)
    return node
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node)
    if (i !== -1) this.childNodes.splice(i, 1)
    node.parentNode = null
    return node
  }
  remove() {
    this.parentNode?.removeChild(this)
  }
  replaceWith(node) {
    this.parentNode?.insertBefore(node, this)
    this.remove()
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true
    return false
  }
  matches(sel) {
    return sel
      .split(',')
      .map((s) => s.trim())
      .some((s) => {
        const [tag, ...classes] = s.split('.')
        if (tag && this.tagName !== tag.toUpperCase()) return false
        return classes.every((c) => this._classes.has(c))
      })
  }
  querySelector(sel) {
    for (const n of this.childNodes) {
      if (n.nodeType !== ELEMENT_NODE) continue
      if (n.matches(sel)) return n
      const deep = n.querySelector(sel)
      if (deep) return deep
    }
    return null
  }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) if (n.nodeType === ELEMENT_NODE && n.matches(sel)) return n
    return null
  }
}

function sibling(node, dir) {
  const sibs = node.parentNode?.childNodes
  if (!sibs) return null
  return sibs[sibs.indexOf(node) + dir] || null
}

// Collapsed caret only — every path under test uses one.
const selection = { startContainer: null, startOffset: 0 }
const fakeWindow = {
  getSelection: () => ({
    rangeCount: selection.startContainer ? 1 : 0,
    isCollapsed: true,
    getRangeAt: () => ({ startContainer: selection.startContainer, startOffset: selection.startOffset }),
    removeAllRanges() {},
    addRange(r) {
      selection.startContainer = r.startContainer
      selection.startOffset = r.startOffset
    },
  }),
}
const fakeDocument = {
  createElement: (tag) => new ElementNode(tag),
  createTextNode: (t) => new TextNode(t),
  createRange: () => ({
    startContainer: null,
    startOffset: 0,
    setStart(node, off) {
      this.startContainer = node
      this.startOffset = off
    },
    setStartAfter(node) {
      this.startContainer = node.parentNode
      this.startOffset = node.parentNode.childNodes.indexOf(node) + 1
    },
    collapse() {},
  }),
  getElementById: (id) => (id === 'hs-mc-input' ? currentInput : null),
}
let currentInput = null
const setCaret = (node, offset) => {
  selection.startContainer = node
  selection.startOffset = offset
}

// ─── carve + evaluate the real implementations ──────────────────────────────

const parts = [
  carve(INPUT_SRC, 'function isInlineChip(', '// Source-text representation of a chip'),
  carve(INPUT_SRC, 'function peelTrailingEmoji(', '// Resolve the element a zero-width completion should stack onto'),
  carve(INPUT_SRC, 'function resolveOverlayBaseLeft(', '// If the word being auto-converted starts at offset 0'),
  carve(INPUT_SRC, 'function completionWantsOverlay(', 'function insertCompletionWysiwyg('),
  carve(INPUT_SRC, 'function insertCompletionWysiwyg(', 'function placeCaretAfter('),
  carve(INPUT_SRC, 'function placeCaretAfter(', '// Cycle-depth + visibility readout'),
  carve(INPUT_SRC, 'function caretOnActiveCompletion(', 'function mergeChipIntoWordForRecompletion('),
  carve(EMOTES_SRC, 'function stackInputEmote(', '// Find last emote element'),
]

const acState = { matches: [], index: 0, active: true, wordStart: 0, afterText: '', search: 'wave' }
const api = new Function(
  'document',
  'window',
  'Node',
  'wysiwygEnabled',
  'acState',
  'getInputText',
  'updateCharCount',
  'attachInputEmoteErrorRecovery',
  `let pendingMessage = ''
   ${parts.join('\n')}
   return { insertCompletionWysiwyg, caretOnActiveCompletion }`,
)(
  fakeDocument,
  fakeWindow,
  { TEXT_NODE, ELEMENT_NODE },
  true,
  acState,
  () => '',
  () => {},
  () => {},
)

// ─── scenario ───────────────────────────────────────────────────────────────

const emote = (name, zeroWidth) => ({ type: 'emote', name, url: `https://cdn.7tv.app/${name}`, zeroWidth })

// "KAK " already committed as a chip, "wave" typed after it — the exact shape
// the composer is in when the reported cycle starts.
function buildComposer() {
  const input = new ElementNode('div')
  input.setAttribute('id', 'hs-mc-input')
  input.isContentEditable = true
  const kak = new ElementNode('img')
  kak.className = 'hs-input-emote'
  kak.alt = 'KAK'
  kak.dataset.emoteName = 'KAK'
  input.appendChild(kak)
  const word = new TextNode(' wave')
  input.appendChild(word)
  currentInput = input
  setCaret(word, word.length)
  return { input, kak }
}

const chips = (input) => input.childNodes.filter((n) => n.nodeType === ELEMENT_NODE)
const touchingChips = (input) => {
  const kids = input.childNodes
  for (let i = 0; i < kids.length - 1; i++) {
    if (kids[i].nodeType === ELEMENT_NODE && kids[i + 1].nodeType === ELEMENT_NODE) return true
  }
  return false
}

describe('Tab-cycle: overlay matches then a non-overlay match', () => {
  test('the cycle survives the stack → standalone transition', () => {
    const { input, kak } = buildComposer()

    // Tab 1-3: overlay matches stack onto KAK.
    api.insertCompletionWysiwyg(emote('wavE', true))
    expect(input.querySelector('.hs-input-stack')).not.toBeNull()
    expect(api.caretOnActiveCompletion(input)).toBe(true)

    api.insertCompletionWysiwyg(emote('CarrotTime', true))
    api.insertCompletionWysiwyg(emote('microwave', true))
    expect(input.querySelector('.hs-input-stack').children.length).toBe(2)
    expect(api.caretOnActiveCompletion(input)).toBe(true)

    // Tab 4: dankwave is NOT an overlay — the chip leaves the stack.
    api.insertCompletionWysiwyg(emote('dankwave', false))
    expect(input.querySelector('.hs-input-stack')).toBeNull()

    // The regression: caret must still sit on the completion, or the next Tab
    // finalizes the cycle and restarts on an empty word (dead Tab/Shift+Tab).
    expect(api.caretOnActiveCompletion(input)).toBe(true)

    // Base and freed chip in order, whitespace-separated (touching chips get
    // rewritten by unwrapStuckChips on the next input).
    const [first, second] = chips(input)
    expect(first).toBe(kak)
    expect(second.dataset.emoteName).toBe('dankwave')
    expect(touchingChips(input)).toBe(false)
    expect(second.classList.contains('hs-input-overlay')).toBe(false)

    // …and cycling back onto an overlay re-stacks, caret intact.
    api.insertCompletionWysiwyg(emote('wavE', true))
    expect(input.querySelector('.hs-input-stack')).not.toBeNull()
    expect(api.caretOnActiveCompletion(input)).toBe(true)
  })

  test('exactly one separator is added on the way out of the stack', () => {
    buildComposer()
    api.insertCompletionWysiwyg(emote('wavE', true))
    api.insertCompletionWysiwyg(emote('dankwave', false))
    const input = currentInput
    // [KAK][ws][dankwave][ws] — no doubled whitespace node between chip and caret
    const kinds = input.childNodes.map((n) => (n.nodeType === ELEMENT_NODE ? 'chip' : 'ws'))
    expect(kinds).toEqual(['chip', 'ws', 'chip', 'ws'])
    for (const n of input.childNodes) {
      if (n.nodeType === TEXT_NODE) expect(n.textContent.trim()).toBe('')
    }
  })

  test('a width pinned for the previous emote does not follow the cycle', () => {
    // hsSnapEmoteBox pins the loaded emote's px width on the chip; a wide lift0
    // left that box behind for every narrower emote Tab landed on after it.
    const { input } = buildComposer()
    api.insertCompletionWysiwyg(emote('lift0', true))
    const cycling = input.querySelector('img.hs-cycling-emote')
    cycling.style.width = '96px'
    api.insertCompletionWysiwyg(emote('dankwave', false))
    expect(cycling.style.width).toBe('')
  })
})
