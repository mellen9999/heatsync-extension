import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * A :has() on an ancestor of the chat list is re-checked for every row added to it, and what
 * the re-check costs is set by the host page's css, not ours: with one rule of kick's in play,
 * `#hs-mc-overlay:has(> #hs-mc-messages > …)` and `body:has(#hs-resize-overlay) …` turned each
 * new row into a re-style of every row on screen (40 of 60 cpu-seconds on a cpu four times
 * slower, 5 frames a second against kick's own 55, 11-18). Both are classes now.
 */
const dir = join(import.meta.dir, '..', 'src', 'multichat')
const CSS = readdirSync(join(dir, 'styles'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(dir, 'styles', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n')

// the compound a `:has(` at `at` belongs to: back to the nearest combinator outside any parens
function compoundOf(sel, at) {
  let depth = 0
  for (let k = at - 1; k >= 0; k--) {
    const c = sel[k]
    if (c === ')') depth++
    else if (c === '(') {
      if (depth === 0) return sel.slice(k + 1, at)
      depth--
    } else if (depth === 0 && (/\s/.test(c) || c === '>' || c === '+' || c === '~' || c === ','))
      return sel.slice(k + 1, at)
  }
  return sel.slice(0, at)
}
const ANCESTOR = /^(html|body)(?![\w-])|#hs-mc-(overlay|container|messages)(?![\w-])/

// kept, each for a reason:
// - youtube rules whose subjects exist on youtube alone (ytd-*, yt-live-chat-app, #teaser-carousel,
//   the panel while youtube's own player is fullscreen). they read youtube's state, which no code
//   of ours is told about, and youtube's css has no rule that makes the re-check costly (2-5ms a
//   row, measured). if youtube ever ships one, these are next.
// - twitch pages with no channel on them: no chat list is drawn there.
const KEPT = [
  ':has(#hs-mc-container) ytd-',
  ':has(#hs-mc-container) yt-live-chat-app',
  ':has(ytd-watch-flexy[fullscreen])',
  ':has(ytd-live-chat-frame#chat[data-hs-hidden])',
  ':has([data-a-target="top-nav-container"])',
]

test('no ancestor of the chat list is the anchor of a :has()', () => {
  const found = []
  for (const m of CSS.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim()
    if (sel.startsWith('@') || !sel.includes(':has(')) continue
    for (let at = sel.indexOf(':has('); at !== -1; at = sel.indexOf(':has(', at + 1)) {
      const compound = compoundOf(sel, at)
      if (!ANCESTOR.test(compound)) continue
      const rest = sel.slice(at, at + 90)
      if (KEPT.some((k) => rest.startsWith(k))) continue
      found.push(`${compound}${rest}`)
    }
  }
  expect(found).toEqual([])
})

test('the kept youtube rules are still the only ones the list above names', () => {
  // a kept entry that matches nothing is a stale excuse
  for (const k of KEPT) expect(CSS.includes(k)).toBe(true)
})

const PANE = readFileSync(join(dir, 'pane-panel.js'), 'utf8')
const a = PANE.indexOf('function watchPaneTaken(msgsEl) {')
const b = PANE.indexOf('\n}\n', a) + 3
if (a < 0) throw new Error('carve: watchPaneTaken')

function list() {
  const win = new Window()
  const doc = win.document
  doc.body.innerHTML = '<div id="hs-mc-overlay"><div id="hs-mc-search-bar"></div><div id="hs-mc-messages"></div></div>'
  const msgs = doc.getElementById('hs-mc-messages')
  const overlay = doc.getElementById('hs-mc-overlay')
  let syncs = 0
  const toggle = overlay.classList.toggle.bind(overlay.classList)
  overlay.classList.toggle = (...args) => {
    syncs++
    return toggle(...args)
  }
  new Function('cleanup', 'MutationObserver', `${PANE.slice(a, b)}\n return watchPaneTaken`)(
    { trackObserver: (o) => o },
    win.MutationObserver,
  )(msgs)
  const add = (cls) => {
    const el = doc.createElement('div')
    el.className = cls
    msgs.appendChild(el)
    return el
  }
  const settle = () => new Promise((r) => setTimeout(r, 0))
  return { overlay, msgs, add, settle, syncs: () => syncs, taken: () => overlay.classList.contains('hs-pane-taken') }
}

test('a card over the list marks the overlay, and its closing unmarks it', async () => {
  const l = list()
  expect(l.taken()).toBe(false)
  const card = l.add('hs-card hs-card-panel')
  await l.settle()
  expect(l.taken()).toBe(true)
  card.remove()
  await l.settle()
  expect(l.taken()).toBe(false)
})

test('a pane panel the same, and one of two closing leaves it marked', async () => {
  const l = list()
  const pane = l.add('hs-pane-panel')
  const card = l.add('hs-card hs-card-panel')
  await l.settle()
  expect(l.taken()).toBe(true)
  pane.remove()
  await l.settle()
  expect(l.taken()).toBe(true)
  card.remove()
  await l.settle()
  expect(l.taken()).toBe(false)
})

test('the list wiped with a card in it unmarks the overlay', async () => {
  const l = list()
  l.add('hs-mc-msg')
  l.add('hs-pane-panel')
  await l.settle()
  expect(l.taken()).toBe(true)
  l.msgs.innerHTML = ''
  await l.settle()
  expect(l.taken()).toBe(false)
})

test('chat rows coming and going cost nothing: the overlay is not touched', async () => {
  const l = list()
  const before = l.syncs()
  const rows = []
  for (let i = 0; i < 50; i++) rows.push(l.add('hs-mc-msg'))
  await l.settle()
  for (const r of rows.slice(0, 20)) r.remove()
  await l.settle()
  expect(l.syncs()).toBe(before)
  expect(l.taken()).toBe(false)
})

test('a floating card is not over the list', async () => {
  const l = list()
  l.add('hs-card hs-card-full')
  await l.settle()
  expect(l.taken()).toBe(false)
})

const POS = readFileSync(join(dir, 'chat-position.js'), 'utf8')
const fa = POS.indexOf('function syncFullscreenClass() {')
if (fa < 0) throw new Error('carve: syncFullscreenClass')
const FS = POS.slice(fa, POS.indexOf('\n}\n', fa) + 3)

test('the body carries hs-fs while something under it is fullscreen, and not for the page itself', () => {
  const win = new Window()
  const doc = win.document
  const player = doc.createElement('div')
  doc.body.appendChild(player)
  let full = null
  const document = {
    get fullscreenElement() {
      return full
    },
    documentElement: doc.documentElement,
    body: doc.body,
  }
  const sync = new Function('document', `${FS}\n return syncFullscreenClass`)(document)
  const on = () => doc.body.classList.contains('hs-fs')
  sync()
  expect(on()).toBe(false)
  full = player
  sync()
  expect(on()).toBe(true)
  full = doc.documentElement
  sync()
  expect(on()).toBe(false)
  full = doc.body
  sync()
  expect(on()).toBe(false)
  full = player
  sync()
  full = null
  sync()
  expect(on()).toBe(false)
})
