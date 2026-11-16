/**
 * History drawn before the channel's emote set landed must pick the set up when it lands.
 *
 * Found on live twitch (s4 e2e, 11-15): a page load draws the server's history rows, the
 * channel's 7tv set arrives a beat later, and a third of those rows kept names like ALMOST
 * as plain text for as long as they stayed on screen. The worker's 3s/8s/20s history
 * re-pull swaps fresh copies of the same lines into the ring (mergeIntoRing, replace mode);
 * the row keeps the copy it was drawn from, reloadEmotesInPlace cleared only the ring's
 * copies, and the row's own memo handed back its first text.
 *
 * Runs the real reloadEmotesInPlace + reprocessEmoteTextInPlace over a happy-dom list.
 */
import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { mainSource } from './main-src.js'

const SRC = mainSource()
function sliceFn(name) {
  const s = SRC.indexOf(`function ${name}(`)
  if (s === -1) throw new Error(`function not found: ${name}`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}

function setup() {
  const win = new Window()
  const doc = win.document
  const msgsEl = doc.createElement('div')
  msgsEl.id = 'hs-mc-messages'
  doc.body.appendChild(msgsEl)
  const channelSet = new Set() // what the channel cache can draw right now
  // computeMessageText's contract: memoised on the message object
  const computeMessageText = (m) => {
    if (m._renderedHtml != null) return m._renderedHtml
    m._renderedHtml = m.text
      .split(' ')
      .map((w) => (channelSet.has(w) ? `<img alt="${w}">` : w))
      .join(' ')
    return m._renderedHtml
  }
  const ring = []
  const irc = { channels: new Map([['jynxzi', { getAll: () => ring }]]) }
  const noop = () => {}
  const fns = new Function(
    'document',
    'computeMessageText',
    'irc',
    'kickChat',
    'mentionsBuffer',
    'channelYtMessages',
    '_dropAllTabCaches',
    'reconcileHeatsyncEmoteStates',
    '_unindexMessageDiv',
    '_indexMessageDiv',
    'isScrolledUp',
    'scrollMsgsToBottom',
    'currentTab',
    '_renderEpoch',
    'rafOrTimeout',
    `${sliceFn('reprocessEmoteTextInPlace')}\n${sliceFn('reloadEmotesInPlace')}\nreturn { reloadEmotesInPlace }`,
  )(doc, computeMessageText, irc, null, [], new Map(), noop, noop, noop, noop, false, noop, 'live', 0, (f) => f())

  /** a row drawn from `m`, the way buildMessageDiv leaves it */
  const draw = (m) => {
    const div = doc.createElement('div')
    div.className = 'hs-mc-msg'
    div.dataset.msgKey = m.id
    const span = doc.createElement('span')
    span.className = 'hs-mc-text'
    span.innerHTML = computeMessageText(m)
    div.appendChild(span)
    div._hsMsg = m
    div._hsAppliedText = span.innerHTML
    msgsEl.appendChild(div)
    return div
  }
  return { ...fns, channelSet, ring, draw, msgsEl }
}

describe('history drawn before the channel set landed', () => {
  test('a row holding an older copy of its line than the ring still takes the new emotes', () => {
    const h = setup()
    const drawnFrom = { id: 'a1', text: 'ALMOST', isHistory: true }
    const row = h.draw(drawnFrom) // drawn as text: the set is not here yet
    // the worker's re-pull: a fresh copy of the same line replaces it in the ring
    h.ring.push({ id: 'a1', text: 'ALMOST', isHistory: true })
    h.channelSet.add('ALMOST') // the channel's 7tv set lands
    h.reloadEmotesInPlace()
    expect(row.querySelector('.hs-mc-text').innerHTML).toBe('<img alt="ALMOST">')
  })

  test('a row whose line is the ring copy takes them too, and an unchanged row is left alone', () => {
    const h = setup()
    const m = { id: 'b1', text: 'ALMOST hi', isHistory: true }
    h.ring.push(m)
    const row = h.draw(m)
    const plain = h.draw({ id: 'b2', text: 'nothing here' })
    const before = plain.querySelector('.hs-mc-text')
    h.channelSet.add('ALMOST')
    h.reloadEmotesInPlace()
    expect(row.querySelector('.hs-mc-text').innerHTML).toBe('<img alt="ALMOST"> hi')
    expect(plain.querySelector('.hs-mc-text')).toBe(before)
    expect(plain.querySelector('.hs-mc-text').innerHTML).toBe('nothing here')
  })
})
