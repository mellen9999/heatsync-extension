/**
 * "hide repeats" on a single channel. An arriving line was judged against a note of the last
 * text APPENDED, kept per tab. The note went stale every time the list was redrawn from the
 * buffers (a tab switch and back, a resume from a pause, a trim): the next line was compared
 * with a line that was no longer the last one, so a repeat was drawn and then taken away by
 * the following redraw, or a new line was held back until one. (The site had the same note
 * on a per-frame holder, 11-17.)
 *
 * Runs the real appendMessage and lastDrawnText against a pane model.
 */
import { expect, test } from 'bun:test'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const cut = (from, to) => {
  const a = SRC.indexOf(from)
  const b = SRC.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`carve: ${from}`)
  return SRC.slice(a, b)
}
const CODE = `${cut('function lastDrawnText(msgsEl) {', '\n}\n')}\n}\n${cut('function appendMessage(msg, tabId) {', '// Render epoch')}`

function pane({ dups = true } = {}) {
  let rows = []
  const row = (m) => ({
    _hsMsg: m,
    dataset: {},
    classList: { contains: () => false },
    get previousElementSibling() {
      return rows[rows.indexOf(this) - 1] || null
    },
  })
  const el = {
    get firstElementChild() {
      return rows[0] || null
    },
    get lastElementChild() {
      return rows.at(-1) || null
    },
    get childElementCount() {
      return rows.length
    },
    appendChild: (r) => rows.push(r),
  }
  const scope = {
    editingChannel: false,
    activeProfileCard: null,
    hsPanePanelOpen: () => false,
    predViewOpen: () => false,
    imgViewOpen: () => false,
    isScrolledUp: false,
    currentTab: 'room',
    _filterFlags: () => ({ dups }),
    isMsgFiltered: () => false,
    ruleHides: () => false,
    lclearCutFor: () => 0,
    liveSearchQuery: () => '',
    isMultiPlatformTab: () => false,
    _skipHiddenRender: () => false,
    document: { getElementById: () => el },
    msgKeyOf: (m) => m.id,
    _msgKeyIndex: new Set(),
    buildMessageDiv: (m) => row(m),
    _renderEpoch: 0,
    stampZebra() {},
    _indexMessageDiv() {},
    _snapCompleteEmotes() {},
    DOM_RENDER_CAP: 500,
    trimMessagesEl() {},
    isUserMuted: () => false,
    stripMcMutedMessage() {},
    scheduleScrollPin() {},
  }
  const appendMessage = new Function('scope', `with (scope) { ${CODE}\n return appendMessage }`)(scope)
  let n = 0
  return {
    say: (text) => appendMessage({ id: `m${++n}`, user: 'u', text, time: n }, 'room'),
    texts: () => rows.map((r) => r._hsMsg.text ?? r._hsMsg.type),
    // the list redrawn from the buffers, as a tab switch back or a resume does
    redraw: (msgs) => {
      rows = []
      for (const m of msgs) rows.push(row(typeof m === 'string' ? { id: `r${++n}`, text: m } : m))
    },
  }
}

test('a line that says what the last line says is not drawn; the next different one is', () => {
  const p = pane()
  p.say('KEKW')
  p.say('KEKW')
  p.say('LUL')
  p.say('KEKW')
  expect(p.texts()).toEqual(['KEKW', 'LUL', 'KEKW'])
})

test('after a redraw the last row on screen is what counts, not the last line appended before it', () => {
  const p = pane()
  p.say('KEKW')
  p.redraw(['KEKW', 'hello', 'LUL']) // chat went on while the tab was away
  p.say('KEKW') // not a repeat of LUL: it was held back
  expect(p.texts()).toEqual(['KEKW', 'hello', 'LUL', 'KEKW'])
  p.redraw(['one', 'LUL'])
  p.say('LUL') // a repeat of the row on screen: it was drawn, and taken away by the next redraw
  expect(p.texts()).toEqual(['one', 'LUL'])
})

test('a row with no text of its own (an event) is looked past', () => {
  const p = pane()
  p.redraw(['LUL', { id: 'e1', type: 'stream-event' }])
  p.say('LUL')
  expect(p.texts()).toEqual(['LUL', 'stream-event'])
  p.say('gg')
  expect(p.texts()).toEqual(['LUL', 'stream-event', 'gg'])
})

test('with the setting off every line is drawn; an empty list holds nothing back', () => {
  const off = pane({ dups: false })
  off.say('KEKW')
  off.say('KEKW')
  expect(off.texts()).toEqual(['KEKW', 'KEKW'])
  const empty = pane()
  empty.say('first')
  expect(empty.texts()).toEqual(['first'])
})
