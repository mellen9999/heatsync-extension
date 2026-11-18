/**
 * A reader scrolls up, clicks a name to look at who is talking, and closes the card. The card
 * takes the whole pane, so the rows being read are gone while it is open. The close redrew the
 * live tail and left the list wherever it fell, still paused, under a "N new" count; and a
 * wheel-up inside a card paused the chat under it, so a reader who was never paused came back
 * to a paused list (real kick and twitch, e2e s23, 11-17).
 *
 * Runs the real takePane, readPanePlace, paneReturn, renderAsOf, newestOrdOnScreen and
 * resetScrollback against a pane model with rows of a fixed height.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const MC = join(import.meta.dir, '..', 'src', 'multichat')
const cut = (from, to) => {
  const a = SRC.indexOf(from)
  const b = SRC.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`carve: ${from}`)
  return SRC.slice(a, b)
}
const CODE = [
  cut('function takePane(msgsEl) {', '// Trim variant that maintains the indices.'),
  cut('function renderAsOf(msgsEl) {', '// How far back a render reads'),
  cut('function newestOrdOnScreen(msgsEl) {', 'const SCROLLBACK_STEP'),
  cut('function resetScrollback() {', '\n}\n'),
  '}',
].join('\n')

const ROW = 20
const VIEW = 400

function room({ lines = 600 } = {}) {
  const buf = Array.from({ length: lines }, (_, i) => ({ ord: i + 1, key: `k${i + 1}` }))
  const pane = {
    children: [],
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 100, bottom: 100 + VIEW }),
    set textContent(_v) {
      pane.children = []
    },
  }
  // a row is ROW high until a picture in it lands (tall.add(key)): then it wraps to two lines
  const tall = new Set()
  const hOf = (m) => (tall.has(m.key) ? 2 * ROW : ROW)
  const draw = (msgs) => {
    const topOf = (i) => msgs.slice(0, i).reduce((n, m) => n + hOf(m), 0)
    pane.children = msgs.map((m, i) => ({
      _hsMsg: m,
      isConnected: true,
      dataset: { msgKey: m.key },
      getBoundingClientRect: () => ({
        top: 100 + topOf(i) - pane.scrollTop,
        bottom: 100 + topOf(i) + hOf(m) - pane.scrollTop,
      }),
    }))
  }
  const scope = {
    isScrolledUp: false,
    hoverHeld: false,
    currentTab: 'room',
    isProgrammaticScroll: false,
    _scrollbackWindow: 0,
    _scrollbackAsOf: null,
    ordOf: (m) => m.ord,
    cleanup: { raf: (fn) => fn() },
    frames: [],
    rafOrTimeout: (fn) => scope.frames.push(fn),
    document: { getElementById: () => pane },
    _clearMessageIndices() {},
    finished: 0,
    finishFirstPaint: () => scope.finished++,
    draws: [],
    renderMessages(_tab, opts) {
      const asOf = api.renderAsOf(pane)
      scope.draws.push({ asOf, bypass: !!opts?.bypassScrollPause })
      draw((asOf === null ? buf : buf.filter((m) => m.ord <= asOf)).slice(-500))
      if (!scope.isScrolledUp) pane.scrollTop = pane.children.length * ROW - VIEW
    },
  }
  const api = new Function(
    'scope',
    `with (scope) { ${CODE}\n return { takePane, paneReturn, renderAsOf, resetScrollback, holdPanePlace, paneHoldScrolled, armPaneHold, kept: () => _paneKept, hold: () => _paneHold } }`,
  )(scope)
  scope.renderMessages()
  const say = (n) => {
    for (let i = 0; i < n; i++) buf.push({ ord: buf.length + 1, key: `k${buf.length + 1}` })
  }
  const firstInView = () => {
    const row = pane.children.find((r) => r.getBoundingClientRect().bottom > 100)
    return { key: row.dataset.msgKey, dy: row.getBoundingClientRect().top - 100 }
  }
  // one frame: what was asked for before it runs
  const frame = () => {
    for (const fn of scope.frames.splice(0)) fn()
  }
  return { ...api, scope, pane, buf, say, firstInView, tall, frame }
}

test('a paused reader opens a card and closes it: the same row sits where it sat, and nothing newer is drawn', () => {
  const r = room()
  r.scope.isScrolledUp = true
  r.pane.scrollTop = 3007 // mid-row: the first row in view is cut by the top edge
  const was = r.firstInView()
  expect(was).toEqual({ key: 'k251', dy: -7 })
  r.takePane(r.pane)
  expect(r.pane.children.length).toBe(0)
  r.pane.scrollTop = 0 // the card starts at its top
  r.say(300) // chat went on behind the card
  r.takePane(r.pane) // the card redrew itself: nothing on screen to read, the place stands
  r.paneReturn()
  expect(r.scope.draws.at(-1)).toEqual({ asOf: 600, bypass: true })
  expect(r.pane.children.at(-1)._hsMsg.ord).toBe(600)
  expect(r.firstInView()).toEqual(was)
  expect(r.scope.isScrolledUp).toBe(true)
  expect(r.scope.finished).toBe(1) // the whole list, not the first step of a cold paint
  expect(r.kept()).toBe(null)
})

test('a reader at the tail gets the live tail back, with what arrived behind the card', () => {
  const r = room()
  r.takePane(r.pane)
  expect(r.kept()).toBe(null)
  r.say(40)
  r.paneReturn()
  expect(r.scope.draws.at(-1)).toEqual({ asOf: null, bypass: true })
  expect(r.pane.children.at(-1)._hsMsg.ord).toBe(640)
  expect(r.scope.finished).toBe(0)
})

test('a second card opened from the tail forgets the place an earlier one kept', () => {
  const r = room()
  r.scope.isScrolledUp = true
  r.pane.scrollTop = 3000
  r.takePane(r.pane)
  expect(r.kept()?.key).toBe('k251')
  // that card went away without handing the pane back (a channel change redrew the tab)
  r.scope.isScrolledUp = false
  r.scope.renderMessages()
  r.takePane(r.pane)
  expect(r.kept()).toBe(null)
})

test('leaving the tab drops the place; a hover hold is not a reader who scrolled up', () => {
  const r = room()
  r.scope.isScrolledUp = true
  r.pane.scrollTop = 3000
  r.takePane(r.pane)
  r.resetScrollback()
  expect(r.kept()).toBe(null)
  const h = room()
  h.scope.isScrolledUp = true
  h.scope.hoverHeld = true
  h.takePane(h.pane)
  expect(h.kept()).toBe(null)
})

test('the row that was being read is gone by the close: the list is left where the redraw put it', () => {
  const r = room()
  r.scope.isScrolledUp = true
  r.pane.scrollTop = 3000
  r.takePane(r.pane)
  r.buf.splice(0, 300) // the buffer let go of it
  r.pane.scrollTop = 0
  expect(() => r.paneReturn()).not.toThrow()
  expect(r.pane.scrollTop).toBe(0)
})

test('every view hands the pane back through the one door, and scrolling inside one is not scrolling the chat', () => {
  for (const [file, fn] of [
    ['profile-card.js', 'function closeProfileCard() {'],
    ['pred-view.js', 'function closePredView() {'],
    ['img-view.js', 'function closeImgView() {'],
  ]) {
    const s = readFileSync(join(MC, file), 'utf8')
    const at = s.indexOf(fn)
    expect(s.slice(at, s.indexOf('\n}\n', at))).toContain('paneReturn()')
  }
  expect(SRC).toContain('const listIsChat = () => !isStaticTab() && !hsPaneTaken()')
  // wheel, touch, the ask for older rows and the hover hold's release; the resume asks the pane itself
  expect(SRC.match(/if \(!listIsChat\(\)\) return/g)?.length).toBe(4)
  expect(SRC).toContain('if (move === null || !listIsChat()) return')
  expect(SRC).toContain('if (isProgrammaticScroll || hsPaneTaken()) return')
})

test('a cold list keeps filling for a reader who scrolled up while it did', () => {
  const grow = cut('function growFirstPaint(id) {', 'function finishFirstPaint() {')
  expect(grow).toContain('renderMessages(id, { bypassScrollPause: true })')
  const finish = cut('function finishFirstPaint() {', '\n}\n')
  expect(finish).toContain('renderMessages(id, { bypassScrollPause: true })')
})

// The redraw leaves the row where it was, and then the rows above it settle: a picture whose
// width was not known wraps its line. Nothing anchors the list (overflow-anchor is off), so the
// reader's row went down by every such line: 154px on a kick channel (e2e s20, 11-18).
const backFromCard = () => {
  const r = room()
  r.scope.isScrolledUp = true
  r.pane.scrollTop = 3007
  const was = r.firstInView()
  r.takePane(r.pane)
  r.pane.scrollTop = 0
  r.paneReturn()
  expect(r.firstInView()).toEqual(was)
  return { r, was }
}

test('rows above the reader grow after the card closed: their row is put back before the frame is painted', () => {
  const { r, was } = backFromCard()
  for (const k of ['k120', 'k180', 'k240']) r.tall.add(k) // three pictures land above
  expect(r.firstInView().key).not.toBe(was.key) // pushed down, as it was
  r.holdPanePlace(r.pane)
  r.holdPanePlace(r.pane) // three load events, one frame
  r.holdPanePlace(r.pane)
  expect(r.scope.frames.length).toBe(1)
  r.frame()
  r.paneHoldScrolled(r.pane) // the scroll event of that write
  expect(r.firstInView()).toEqual(was)
  expect(r.hold()).not.toBe(null)
})

// The scroll that put the reader back comes to rest a moment later. Link cards above them had
// filled in by then (no picture event says so), and that rest was read as the reader stopping
// there: the pushed-down place became the one kept, 396px low on a kick channel (e2e s20, 11-18).
test('the scroll that put the reader back comes to rest after rows above grew: their row is put back, not the new place kept', () => {
  const { r, was } = backFromCard()
  for (const k of ['k120', 'k180', 'k240']) r.tall.add(k)
  expect(r.firstInView()).not.toEqual(was)
  r.paneHoldScrolled(r.pane) // the scroll event of the put-back: the list is where the hold left it
  r.armPaneHold(r.pane) // and its scrollend
  r.frame()
  r.paneHoldScrolled(r.pane)
  expect(r.firstInView()).toEqual(was)
  // more rows settle after it
  r.tall.add('k60')
  r.holdPanePlace(r.pane)
  r.frame()
  expect(r.firstInView()).toEqual(was)
})

test('a picture that lands below the reader moves nothing', () => {
  const { r, was } = backFromCard()
  const top = r.pane.scrollTop
  r.tall.add('k400')
  r.holdPanePlace(r.pane)
  r.frame()
  expect(r.pane.scrollTop).toBe(top)
  expect(r.firstInView()).toEqual(was)
})

test("the reader's own scroll ends it: a picture landing after that moves nothing", () => {
  const { r } = backFromCard()
  r.pane.scrollTop -= 200 // the reader wheels further up
  r.paneHoldScrolled(r.pane)
  expect(r.hold()).toBe(null)
  const top = r.pane.scrollTop
  r.tall.add('k50')
  r.holdPanePlace(r.pane)
  r.frame()
  expect(r.pane.scrollTop).toBe(top)
})

test('it ends by itself when the reader is back at the tail, and time alone does not end it', () => {
  const late = backFromCard().r
  const now = Date.now
  try {
    Date.now = () => now() + 60_000
    late.tall.add('k120')
    late.holdPanePlace(late.pane)
    late.frame()
  } finally {
    Date.now = now
  }
  expect(late.hold()).not.toBe(null)
  expect(late.firstInView().key).toBe('k251')

  const tail = backFromCard().r
  tail.scope.isScrolledUp = false
  tail.holdPanePlace(tail.pane)
  expect(tail.hold()).toBe(null)
})

// No card at all: a reader wheels up, stops, and reads. A picture above them lands a moment
// later and their row went down a line (real twitch, e2e s20, 11-18: 15px to 36px).
const paused = (at = 3007) => {
  const r = room()
  r.scope.isScrolledUp = true
  r.pane.scrollTop = at
  r.armPaneHold(r.pane) // the scroll came to rest
  return r
}

test('a reader who only scrolled up keeps their row when a picture above it lands', () => {
  const r = paused()
  const was = r.firstInView()
  expect(was).toEqual({ key: 'k251', dy: -7 })
  r.tall.add('k200')
  expect(r.firstInView()).not.toEqual(was)
  r.holdPanePlace(r.pane)
  r.frame()
  r.paneHoldScrolled(r.pane)
  expect(r.firstInView()).toEqual(was)
})

test('they scroll on: where that scroll stops is the place kept next', () => {
  const r = paused()
  r.pane.scrollTop -= 400
  r.paneHoldScrolled(r.pane)
  expect(r.hold()).toBe(null) // mid-scroll nothing is put back
  r.tall.add('k100')
  r.holdPanePlace(r.pane)
  expect(r.scope.frames.length).toBe(0)
  r.armPaneHold(r.pane)
  const was = r.firstInView()
  r.tall.add('k150')
  r.holdPanePlace(r.pane)
  r.frame()
  expect(r.firstInView()).toEqual(was)
})

test('a list at its tail, and one held by a hover, keep no place', () => {
  const tail = room()
  tail.armPaneHold(tail.pane)
  expect(tail.hold()).toBe(null)
  const hover = room()
  hover.scope.isScrolledUp = true
  hover.scope.hoverHeld = true
  hover.pane.scrollTop = 3000
  hover.armPaneHold(hover.pane)
  expect(hover.hold()).toBe(null)
})

test('the row being kept leaves the list: the hold is over, nothing is moved', () => {
  const r = paused()
  r.hold().row.isConnected = false
  const top = r.pane.scrollTop
  r.tall.add('k200')
  r.holdPanePlace(r.pane)
  r.frame()
  expect(r.hold()).toBe(null)
  expect(r.pane.scrollTop).toBe(top)
})

test('a reader who was at the tail gets no hold at all', () => {
  const r = room()
  r.takePane(r.pane)
  r.paneReturn()
  expect(r.hold()).toBe(null)
})

test('the list tells the hold about every picture and every scroll', () => {
  const ov = readFileSync(join(MC, 'main-overlay.js'), 'utf8')
  const h = ov.slice(ov.indexOf('const onImgLoadOrError = (e) => {'))
  expect(h.indexOf('holdPanePlace(msgsEl)')).toBeLessThan(h.indexOf("if (e?.type === 'error')"))
  expect(ov).toMatch(/'scroll',\s+\(\) => \{\s+paneHoldScrolled\(msgsEl\)/)
  // and of where every scroll comes to rest
  const end = ov.slice(ov.indexOf("'scrollend',"))
  expect(end.slice(0, end.indexOf('{ signal: mcSignal }'))).toContain('if (listIsChat()) armPaneHold(msgsEl)')
  // and of rows that take their height with no picture event
  expect(ov).toMatch(/msgsEl\.addEventListener\('hs-row-settled', onImgLoadOrError,/)
  expect(ov).toMatch(/msgsEl\.addEventListener\('loadedmetadata', onImgLoadOrError, \{ capture: true,/)
})

// A link in chat draws a placeholder and is filled in when the server answers: the card is
// taller than the placeholder was. Runs the real resolvePendingFeedEmbeds on a real page.
test('a link card that fills in tells the list it sits in, whether it resolved or failed', async () => {
  const { Window } = await import('happy-dom')
  const EMBED = readFileSync(join(MC, 'feed-embed.js'), 'utf8')
  const a = EMBED.indexOf('function _swapPlaceholder(')
  const b = EMBED.indexOf('// Wire load-fail fallbacks', a)
  const window = new Window()
  const document = window.document
  const answers = { 'https://a.example/x': { type: 'link', title: 'x' }, 'https://b.example/y': { error: 'gone' } }
  const { resolvePendingFeedEmbeds } = new Function(
    'document',
    'Event',
    '_fetchFeedResolve',
    '_buildFeedResolvedHtml',
    '_buildFeedResolveFailedHtml',
    'attachFeedFallbacks',
    `${EMBED.slice(a, b)}\nreturn { resolvePendingFeedEmbeds }`,
  )(
    document,
    window.Event,
    (url) => Promise.resolve(answers[url]),
    () => '<a class="card">card</a>',
    () => '<span class="failed">link</span>',
    () => {},
  )
  const list = document.createElement('div')
  list.id = 'hs-mc-messages'
  document.body.appendChild(list)
  const told = []
  list.addEventListener('hs-row-settled', (e) => told.push(e.target.dataset.resolveUrl))
  for (const url of Object.keys(answers)) {
    const row = document.createElement('div')
    const ph = document.createElement('div')
    ph.className = 'hs-feed-embed-pending'
    ph.dataset.resolveUrl = url
    row.appendChild(ph)
    list.appendChild(row)
  }
  // a row that left the list while the answer was on its way says nothing
  const gone = document.createElement('div')
  gone.className = 'hs-feed-embed-pending'
  gone.dataset.resolveUrl = 'https://a.example/x'
  const goneRow = document.createElement('div')
  goneRow.appendChild(gone)
  list.appendChild(goneRow)
  resolvePendingFeedEmbeds(list)
  goneRow.remove()
  await new Promise((r) => setTimeout(r, 0))
  expect(told).toEqual(['https://a.example/x', 'https://b.example/y'])
  expect(list.querySelector('.card')).toBeTruthy()
  expect(list.querySelector('.failed')).toBeTruthy()
})
