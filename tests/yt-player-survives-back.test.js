/**
 * "clicked a yt embed to watch/listen, clicked back so i'd still see chat and listen, and it
 * stopped." Back used to pause the player, and a card that aged out of the row cap (or a tab
 * switch that rebuilt the rows) made the parked player stop itself. A player you started keeps
 * playing until you close it. Runs the real player code from src/multichat/feed-embed.js.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'feed-embed.js'), 'utf8')
const cut = (a, b) => {
  const s = SRC.indexOf(a)
  const e = SRC.indexOf(b, s)
  if (s < 0 || e < 0) throw new Error(`markers not found: ${a}`)
  return SRC.slice(s, e)
}
const STATE = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-state.js'), 'utf8')
const SNAP = STATE.slice(
  STATE.indexOf('function snapshotTabState('),
  STATE.indexOf('\n}\n', STATE.indexOf('function snapshotTabState(')) + 3,
)
const BODY = `${cut('const _AUDIO_PROVIDERS = [', '// Providers announce themselves')}\n${cut('function _hsSetFill(', '// A programmatic autoscroll')}`
const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

let win
afterEach(() => win?.happyDOM.close())

function setup() {
  win = new Window()
  const d = win.document
  d.body.innerHTML = '<div id="hs-mc-overlay"><div id="hs-mc-messages"></div></div>'
  const scroller = d.getElementById('hs-mc-messages')
  const addRow = () => {
    const row = d.createElement('div')
    row.innerHTML = `<a class="hs-mc-media hs-mc-playable" data-resolve-url="${URL_}"></a>`
    scroller.appendChild(row)
    return row
  }
  const cleanup = {
    setTimeout: (f, n) => win.setTimeout(f, n),
    clearTimeout: (x) => win.clearTimeout(x),
    setInterval: () => 0,
    clearInterval: () => {},
    trackObserver: () => {},
  }
  const api = new Function(
    'document',
    'window',
    'cleanup',
    't',
    'hsTakeoverSync',
    'swallow',
    'sanitizeEmbedId',
    'safeUrl',
    'EMBED_SANDBOX',
    'ResizeObserver',
    'hsXButton',
    `${BODY}\nreturn { chatEmbedToggle, _hsSetFill, _hsPlacePlayer, _hsAudioStop, st: () => _hsAudio }`,
  )(
    d,
    win,
    cleanup,
    (k) => k,
    () => {},
    () => {},
    (id) => id,
    (u) => u,
    'allow-scripts',
    undefined,
    (cls, _l, onClick) => {
      const b = d.createElement('button')
      b.className = `hs-x ${cls}`
      b.addEventListener('click', onClick)
      return b
    },
  )
  return { d, scroller, addRow, ...api }
}

test('back keeps it playing, trim + repaint + tab switch keep the same iframe, close frees it', () => {
  const { d, scroller, addRow, chatEmbedToggle, _hsSetFill, _hsPlacePlayer, _hsAudioStop, st } = setup()
  const row = addRow()
  const card = row.firstElementChild
  expect(chatEmbedToggle(URL_, card)).toBe(true)
  const frame = st().frame
  expect(st().fill).toBe(true)

  _hsSetFill(false) // back
  expect(st().playing).toBe(true)
  expect(st().frame).toBe(frame)

  row.remove() // aged out of the scrollback cap
  _hsPlacePlayer()
  expect(st()).not.toBeNull()
  expect(st().frame).toBe(frame)
  expect(frame.isConnected).toBe(true)
  expect(st().playing).toBe(true)

  // full repaint: the reconciler sweeps every row and spares the player slot
  for (const c of [...scroller.children]) if (c.id !== 'hs-mc-embed-player') c.remove()
  addRow()
  _hsPlacePlayer()
  expect(st().frame).toBe(frame)
  expect(frame.isConnected).toBe(true)
  expect(st().card.isConnected).toBe(true) // re-parked over the returned card

  d.querySelector('.hs-mc-transport-close').click()
  expect(st()).toBeNull()
  expect(frame.isConnected).toBe(false)
  expect(d.getElementById('hs-mc-embed-player')).toBeNull()
  _hsAudioStop()
})

test('a tab switch snapshots the rows but leaves the player in the scroller', () => {
  const { scroller, addRow, chatEmbedToggle, _hsPlacePlayer, d, st } = setup()
  const card = addRow().firstElementChild
  addRow()
  chatEmbedToggle(URL_, card)
  const frame = st().frame
  const cache = new Map()
  const snap = new Function(
    'document',
    '_isChatTab',
    '_tabCache',
    '_msgKeyIndex',
    '_uidIndex',
    '_mentionIndex',
    'isScrolledUp',
    'newMessageCount',
    '_TAB_CACHE_MAX',
    `${SNAP}\nreturn snapshotTabState`,
  )(d, () => true, cache, new Set(), new Map(), new Map(), false, 0, 8)
  snap('tab1')
  expect(cache.get('tab1').frag.children.length).toBe(2)
  expect(scroller.contains(frame)).toBe(true)
  expect(st().frame).toBe(frame)
  _hsPlacePlayer()
  expect(st().playing).toBe(true)
  expect(st().host.parentNode).toBe(scroller)
})
