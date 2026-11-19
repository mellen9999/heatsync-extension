import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * A selector that puts + or ~ on a row of the chat list marks the list "my children depend on
 * their neighbours". From then on a row taken off the top, or put in mid-list, asks every sibling
 * rule on the page what to re-style, the host page's included: kick's sheet has `> svg ~ *`, and
 * with our `.hs-filled + .hs-filled` in play each such row re-styled every element of the list
 * (3000 elements, 30ms a time; style work 620ms of 12s against 277ms without it, 11-18). The gap
 * between two touching filled rows is a class on the row now, kept by watchFillTouch.
 */
const dir = join(import.meta.dir, '..', 'src', 'multichat')
const CSS = readdirSync(join(dir, 'styles'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(dir, 'styles', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n')

// what stands right of each + or ~ in a selector: the element the neighbour is asked about
function askedAbout(sel) {
  // attribute values and an+b arguments hold + and ~ that are not combinators
  const hide = (m) => m.replace(/[+~]/g, '_')
  const flat = sel.replace(/\[[^\]]*\]/g, hide).replace(/:nth-[\w-]+\([^)]*?(?=\)| of )/g, hide)
  const out = []
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] !== '+' && flat[i] !== '~') continue
    let j = i + 1
    while (/\s/.test(flat[j] || '')) j++
    let depth = 0
    let k = j
    for (; k < flat.length; k++) {
      const c = flat[k]
      if (c === '(') depth++
      else if (c === ')') {
        if (depth === 0) break
        depth--
      } else if (depth === 0 && (/\s/.test(c) || c === '>' || c === '+' || c === '~' || c === ',')) break
    }
    out.push(sel.slice(j, k))
  }
  return out
}

// each of these is never a row of the list: a part of a row, a part of the page, a popup's own row
const NEVER_A_ROW = [
  '.hs-mc-emote-wrapper',
  '.hs-mc-emote-stack',
  '.hs-mc-settings-group',
  '.hs-discover-section',
  '#hs-mc-container',
  '[class*="tabs-buttons"]',
  'button', // twitch's leaderboard header: `.channel-leaderboard-header-rotating__users ~ button`
  '.hs-filled.hs-mc-reply-stack-row',
]

test('no selector asks a row of the list about its neighbours', () => {
  const found = []
  for (const m of CSS.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim()
    if (sel.startsWith('@')) continue
    for (const el of askedAbout(sel))
      if (!NEVER_A_ROW.includes(el)) found.push(`${el}   in   ${sel.replace(/\s+/g, ' ').slice(0, 120)}`)
  }
  // a new one: if what stands right of the + or ~ can never be a child of #hs-mc-messages, add it
  // above with why; if it can, say it with a class kept in js (see fill-touch.js)
  expect(found).toEqual([])
})

test('the list above names nothing the css no longer has', () => {
  const live = new Set()
  for (const m of CSS.matchAll(/([^{}]+)\{/g)) for (const el of askedAbout(m[1])) live.add(el)
  for (const el of NEVER_A_ROW) expect(live.has(el), el).toBe(true)
})

test('the reader of selectors sees a combinator where there is one and none where there is not', () => {
  expect(askedAbout('.a + .b')).toEqual(['.b'])
  expect(askedAbout('.a~.b.c > .d')).toEqual(['.b.c'])
  expect(askedAbout('.p:has(+ .q:not(.r)) .s')).toEqual(['.q:not(.r)'])
  expect(askedAbout('.a:nth-child(2n+1) [data-x="a+b~c"]:nth-last-child(-n + 3)')).toEqual([])
})

test('the gap is the same line the site draws', () => {
  expect(CSS).toContain('.hs-filled.hs-fill-touch { border-top: var(--brand-row-gap) solid #000000; }')
})

const SRC = readFileSync(join(dir, 'fill-touch.js'), 'utf8')

function list() {
  const win = new Window()
  const doc = win.document
  doc.body.innerHTML = '<div id="hs-mc-messages"></div>'
  const msgs = doc.getElementById('hs-mc-messages')
  const row = (filled) => {
    const el = doc.createElement('div')
    el.className = filled ? 'hs-mc-msg hs-filled hs-fill-navy' : 'hs-mc-msg'
    return el
  }
  const start = () =>
    new Function('cleanup', 'MutationObserver', `${SRC}\n return watchFillTouch`)(
      { trackObserver: (o) => o },
      win.MutationObserver,
    )(msgs)
  const settle = () => new Promise((r) => setTimeout(r, 0))
  // what the sibling selector would have matched, read from the list as it stands
  const want = () =>
    [...msgs.children].map((el) => el.matches('.hs-filled') && !!el.previousElementSibling?.matches('.hs-filled'))
  const have = () => [...msgs.children].map((el) => el.classList.contains('hs-fill-touch'))
  return { doc, msgs, row, start, settle, want, have }
}

test('a filled row under a filled row is marked, a filled row under a plain one is not', async () => {
  const l = list()
  l.start()
  l.msgs.append(l.row(false), l.row(true), l.row(true), l.row(false), l.row(true))
  await l.settle()
  expect(l.have()).toEqual([false, false, true, false, false])
  expect(l.have()).toEqual(l.want())
})

test('rows already in the list when the watch starts are marked', () => {
  const l = list()
  l.msgs.append(l.row(true), l.row(true), l.row(true))
  l.start()
  expect(l.have()).toEqual([false, true, true])
})

test('the top row trimmed away: the row that is first now has nothing above it', async () => {
  const l = list()
  l.start()
  l.msgs.append(l.row(true), l.row(true), l.row(true))
  await l.settle()
  l.msgs.firstElementChild.remove()
  await l.settle()
  expect(l.have()).toEqual([false, true])
})

test('a plain row put between two filled rows parts them, and its leaving joins them again', async () => {
  const l = list()
  l.start()
  const a = l.row(true)
  const b = l.row(true)
  l.msgs.append(a, b)
  await l.settle()
  const mid = l.row(false)
  l.msgs.insertBefore(mid, b)
  await l.settle()
  expect(l.have()).toEqual([false, false, false])
  mid.remove()
  await l.settle()
  expect(l.have()).toEqual([false, true])
})

test('older rows put in above, one by one or as a batch', async () => {
  const l = list()
  l.start()
  l.msgs.append(l.row(true), l.row(false))
  await l.settle()
  l.msgs.prepend(l.row(true))
  await l.settle()
  expect(l.have()).toEqual(l.want())
  const batch = l.doc.createDocumentFragment()
  batch.append(l.row(true), l.row(true), l.row(false), l.row(true))
  l.msgs.prepend(batch)
  await l.settle()
  expect(l.have()).toEqual([false, true, false, false, true, true, false])
  expect(l.have()).toEqual(l.want())
})

test('a row swapped for a rebuilt one, and many changes in one turn', async () => {
  const l = list()
  l.start()
  l.msgs.append(l.row(true), l.row(false), l.row(true), l.row(true))
  await l.settle()
  l.msgs.children[1].replaceWith(l.row(true))
  await l.settle()
  expect(l.have()).toEqual([false, true, true, true])
  // one turn: a row added, the one before it removed, another added mid-list and removed again
  l.msgs.append(l.row(true))
  l.msgs.children[3].remove()
  const gone = l.row(false)
  l.msgs.insertBefore(gone, l.msgs.children[1])
  gone.remove()
  l.msgs.insertBefore(l.row(false), l.msgs.children[2])
  await l.settle()
  expect(l.have()).toEqual(l.want())
})

test('the list wiped and drawn again', async () => {
  const l = list()
  l.start()
  l.msgs.append(l.row(true), l.row(true))
  await l.settle()
  l.msgs.replaceChildren(l.row(false), l.row(true), l.row(true))
  await l.settle()
  expect(l.have()).toEqual([false, false, true])
})

test('a row whose mark is already right is not written to', async () => {
  const l = list()
  l.start()
  const rows = [l.row(false), l.row(true), l.row(true)]
  let writes = 0
  for (const r of rows) {
    const toggle = r.classList.toggle.bind(r.classList)
    r.classList.toggle = (...args) => {
      writes++
      return toggle(...args)
    }
  }
  l.msgs.append(...rows)
  await l.settle()
  expect(writes).toBe(1)
  l.msgs.append(l.row(false))
  await l.settle()
  expect(writes).toBe(1)
})
