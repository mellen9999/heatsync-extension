/**
 * A live filter is up and chat keeps arriving. Only merged tabs asked the filter before drawing an
 * arriving line: on a single channel every new line was drawn under the filter, so a search for
 * one name filled up with everybody else's rows within seconds (real twitch, e2e s22, 11-17).
 *
 * Runs the real appendMessage against a pane model: a line the filter hides draws nothing, a line
 * it keeps goes to the render (which also counts the matches), and with no filter the line is
 * appended as before.
 */
import { expect, test } from 'bun:test'
import { buildLiveSearchMatcher, liveSearchMatcherFor } from '../src/multichat/live-search.js'
import { mainSource } from './main-src.js'

const SRC = mainSource()
const at = SRC.indexOf('function appendMessage(msg, tabId) {')
const APPEND = SRC.slice(at, SRC.indexOf('// Render epoch', at))

function pane({ query = '', merged = false } = {}) {
  const rows = []
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
    children: rows,
    appendChild: (r) => rows.push(r),
  }
  const seen = { renders: 0 }
  const scope = {
    editingChannel: false,
    activeProfileCard: null,
    hsPanePanelOpen: () => false,
    predViewOpen: () => false,
    imgViewOpen: () => false,
    isScrolledUp: false,
    currentTab: 'room',
    _filterFlags: () => ({ dups: false }),
    isMsgFiltered: () => false,
    ruleHides: () => false,
    lclearCutFor: () => 0,
    lastDrawnText: () => null,
    liveSearchQuery: () => query,
    liveSearchMatcherFor,
    scheduleMergedRender: () => seen.renders++,
    isMultiPlatformTab: () => merged,
    mtCanAppend: () => !query,
    mayBeSimulcastLeg: () => false,
    _skipHiddenRender: () => false,
    document: { getElementById: () => el },
    msgKeyOf: (m) => m.id,
    _msgKeyIndex: new Set(),
    buildMessageDiv: (m) => ({ dataset: {}, classList: { contains: () => false }, user: m.user, text: m.text }),
    _renderEpoch: 0,
    stampZebra() {},
    _indexMessageDiv() {},
    _snapCompleteEmotes() {},
    mtNoteAppend() {},
    DOM_RENDER_CAP: 500,
    trimMessagesEl() {},
    isUserMuted: () => false,
    stripMcMutedMessage() {},
    scheduleScrollPin() {},
  }
  const appendMessage = new Function('scope', `with (scope) { ${APPEND}\n return appendMessage }`)(scope)
  return { rows, seen, send: (id, user, text) => appendMessage({ id, user, text, time: 1 }, 'room') }
}

for (const merged of [false, true]) {
  const kind = merged ? 'a merged tab' : 'a single channel'
  test(`${kind}: a line the filter hides draws nothing and asks for nothing`, () => {
    const p = pane({ query: 'cesii', merged })
    expect(p.send('1', 'yolayzex', '@yostbl')).toBe(true)
    expect(p.send('2', 'daybeenlive', 'W GTA 6')).toBe(true)
    expect([p.rows.length, p.seen.renders]).toEqual([0, 0])
  })

  test(`${kind}: a line the filter keeps goes to the render, by name or by text`, () => {
    const p = pane({ query: 'cesii', merged })
    expect(p.send('1', 'cesii', 'hello')).toBe(true)
    expect(p.send('2', 'someone', 'hi Cesii')).toBe(true)
    expect([p.rows.length, p.seen.renders]).toEqual([0, 2]) // the render draws it and counts it
  })
}

test('no filter: the line is appended as before, no render asked', () => {
  const p = pane()
  expect(p.send('1', 'yolayzex', '@yostbl')).toBe(true)
  expect([p.rows.length, p.seen.renders]).toEqual([1, 0])
})

test('one compiled matcher per query, a new one when the query changes', () => {
  const a = liveSearchMatcherFor('/ce+sii/i')
  expect(liveSearchMatcherFor('/ce+sii/i')).toBe(a)
  expect(a.test({ user: 'CEEsii', text: '' })).toBe(true)
  const b = liveSearchMatcherFor('@bob')
  expect(b).not.toBe(a)
  expect(b.test({ user: 'bob', text: 'x' })).toBe(buildLiveSearchMatcher('@bob').test({ user: 'bob', text: 'x' }))
  expect(b.test({ user: 'alice', text: 'bob' })).toBe(
    buildLiveSearchMatcher('@bob').test({ user: 'alice', text: 'bob' }),
  )
})
