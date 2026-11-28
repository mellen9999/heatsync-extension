/**
 * The follows list (Alt+L / space f): a row's only mouse path was a double-click, which a finger does not
 * have (a second tap within a beat is a zoom, not a dblclick) and a first click only moved the selection.
 * So a tap on a row did nothing you could see lead anywhere. A click on the row that is already selected
 * opens it, exactly like Enter; a double-click is just two of them, so it opens once. The real
 * openFollowsView carved from the source, its pane panel and tab calls stubbed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

const SRC = readFileSync(new URL('../src/multichat/follows-view.js', import.meta.url), 'utf8')
const any = new Proxy(() => {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => undefined })
const scopeOf = (own) =>
  new Proxy(own, {
    has: (t, k) => typeof k === 'string' && (k in t || globalThis[k] === undefined),
    get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : any),
    set: (o, k, v) => {
      o[k] = v
      return true
    },
  })

function open(snapshot) {
  const win = new Window({ url: 'https://www.twitch.tv/x' })
  const doc = win.document
  const calls = { tabs: [], added: [], watched: [], closed: 0 }
  const own = {
    document: doc,
    window: { open: (u) => calls.watched.push(u) },
    t: (k) => k,
    config: { channels: [{ id: 'nix', twitch: 'nix', kick: '', youtube: '' }] },
    switchTab: (id) => calls.tabs.push(id),
    addChannelsBulk: (e) => calls.added.push(e),
    hsPanePanelOpenWith: (o) => {
      doc.body.appendChild(o.body)
      return {}
    },
    activePanePanel: {
      finish: () => {
        calls.closed++
      },
    },
  }
  const run = new Function('scope', `with (scope) { ${SRC}\nreturn { openFollowsView, followsSet } }`)(scopeOf(own))
  run.followsSet(snapshot)
  run.openFollowsView()
  const rows = () => [...doc.querySelectorAll('.hs-fl-row')]
  const fire = (el, type) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true }))
  return { calls, rows, fire }
}

const snap = [
  { platform: 'twitch', username: 'nix', viewers: 900 },
  { platform: 'kick', username: 'eddie', viewers: 500 },
  { platform: 'twitch', username: 'zed', viewers: 10 },
]

describe('follows list: click and tap', () => {
  test('the first click only selects, the second click on that row opens it', () => {
    const h = open(snap)
    expect(h.rows().length).toBe(3)
    h.fire(h.rows()[1], 'click')
    expect(h.calls.tabs.length + h.calls.added.length).toBe(0)
    expect(h.rows()[1].classList.contains('hs-fl-sel')).toBe(true)
    h.fire(h.rows()[1], 'click') // rows are rebuilt on each select: a fresh element, as a real second tap hits
    expect(h.calls.added).toEqual([[{ kick: 'eddie' }]])
    expect(h.calls.closed).toBe(1)
  })
  test('a saved channel is switched to, not added again', () => {
    const h = open(snap)
    h.fire(h.rows()[0], 'click') // the first row starts selected
    expect(h.calls.tabs).toEqual(['nix'])
    expect(h.calls.added.length).toBe(0)
  })
  test('a real double-click (click, click, dblclick) opens once', () => {
    const h = open(snap)
    h.fire(h.rows()[2], 'click')
    h.fire(h.rows()[2], 'click')
    h.fire(h.rows()[2], 'dblclick')
    expect(h.calls.added.length + h.calls.tabs.length).toBe(1)
  })
})
