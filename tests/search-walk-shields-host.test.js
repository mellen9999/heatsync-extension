import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * With a chat filter up and nothing focused, n and N walk its matches. The listener sat on
 * document in the bubble phase, behind every listener the site had put there first, and only
 * marked the event as handled. Youtube binds shift+n to "next video": the press that stepped a
 * match back also changed the video, and the chat that was being searched was gone (e2e s22,
 * 11-18, twice in a row). The key is now taken on the root element in the capture phase, after
 * type-to-focus and before the host.
 *
 * Runs the real initSearchWalkKeys, ownKeyup, initOwnedKeyups and initTypeToFocus on a real page
 * with real key events.
 */
const dir = join(import.meta.dir, '..', 'src', 'multichat')
const KEYS = readFileSync(join(dir, 'overlay-keys.js'), 'utf8')
const TYPE = readFileSync(join(dir, 'type-to-focus.js'), 'utf8').replace('export function', 'function')
const OVERLAY = readFileSync(join(dir, 'main-overlay.js'), 'utf8')
// old source kept the listener inline in main-overlay.js: run that one, so the test fails on what it checks
const OLD = (() => {
  if (KEYS.includes('function initSearchWalkKeys')) return ''
  const a = OVERLAY.indexOf(
    "document.addEventListener(\n  'keydown',\n  (e) => {\n    if (e.key !== 'n' && e.key !== 'N') return",
  )
  const b = OVERLAY.indexOf('{ signal: mcSignal },\n)', a)
  if (a < 0 || b < 0) throw new Error('carve: the n/N listener')
  return `function initSearchWalkKeys(mcSignal, cycleLiveSearch) {\n${OVERLAY.slice(a, b)}{ signal: mcSignal },\n)\n}`
})()

function page({ onPanel = false } = {}) {
  const window = new Window()
  const document = window.document
  const composer = document.createElement('input')
  composer.id = 'hs-mc-input'
  document.body.appendChild(composer)
  if (onPanel) document.body.classList.add('hs-popout') // the panel is the window: attention is ours
  const heard = []
  const host = (where) => (e) => heard.push(`${where}:${e.type}:${e.key}${e.defaultPrevented ? ':prevented' : ''}`)
  const ctl = new window.AbortController()
  const api = new Function(
    'document',
    'window',
    'Event',
    `${KEYS}\n${OLD}\n${TYPE}\nreturn { initSearchWalkKeys, initOwnedKeyups, initTypeToFocus }`,
  )(document, window, window.Event)
  const walked = []
  let filterUp = true
  const press = (key, target = document.body, init = {}) => {
    const down = new window.KeyboardEvent('keydown', { key, code: 'KeyN', bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(down)
    const up = new window.KeyboardEvent('keyup', { key, code: 'KeyN', bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(up)
    return down
  }
  // the host was there first, everywhere a player shortcut can sit
  const hostEverywhere = () => {
    for (const type of ['keydown', 'keyup']) {
      document.body.addEventListener(type, host('body'))
      document.addEventListener(type, host('document'))
      window.addEventListener(type, host('window'))
    }
  }
  const start = () => {
    api.initOwnedKeyups(ctl.signal)
    api.initTypeToFocus(ctl.signal)
    api.initSearchWalkKeys(ctl.signal, (dir) => {
      if (!filterUp) return false
      walked.push(dir)
      return true
    })
  }
  return { window, document, composer, heard, walked, press, hostEverywhere, start, noFilter: () => (filterUp = false) }
}

test('N steps a match back and the host hears neither the press nor the release', () => {
  const p = page()
  p.hostEverywhere()
  p.start()
  const e = p.press('N', p.document.body, { shiftKey: true })
  expect(p.walked).toEqual([-1])
  expect(e.defaultPrevented).toBe(true)
  expect(p.heard).toEqual([])
})

test('n steps forward the same way', () => {
  const p = page()
  p.hostEverywhere()
  p.start()
  p.press('n')
  p.press('n')
  expect(p.walked).toEqual([1, 1])
  expect(p.heard).toEqual([])
})

test('the player itself had focus: its own listener does not hear a walked key', () => {
  const p = page()
  const player = p.document.createElement('div')
  player.tabIndex = 0
  p.document.body.appendChild(player)
  player.addEventListener('keydown', (e) => p.heard.push(`player:${e.key}`))
  p.start()
  player.focus()
  p.press('N', player, { shiftKey: true })
  expect(p.walked).toEqual([-1])
  expect(p.heard).toEqual([])
})

test("no filter up: the key is the host's, untouched", () => {
  const p = page()
  p.hostEverywhere()
  p.noFilter()
  p.start()
  const e = p.press('N', p.document.body, { shiftKey: true })
  expect(p.walked).toEqual([])
  expect(e.defaultPrevented).toBe(false)
  expect(p.heard).toEqual([
    'body:keydown:N',
    'document:keydown:N',
    'window:keydown:N',
    'body:keyup:N',
    'document:keyup:N',
    'window:keyup:N',
  ])
})

test('the pointer is on chat: the letter is typed into the composer, not walked', () => {
  const p = page({ onPanel: true })
  p.start()
  p.press('n')
  expect(p.composer.value).toBe('n')
  expect(p.walked).toEqual([])
})

test('typing n in a field of the page, or with a modifier held, walks nothing', () => {
  const p = page()
  p.start()
  const field = p.document.createElement('input')
  p.document.body.appendChild(field)
  field.focus()
  p.press('n', field)
  p.press('n', p.document.body, { ctrlKey: true })
  p.press('n', p.document.body, { altKey: true })
  expect(p.walked).toEqual([])
})

test('a key one of our own handlers claimed first is not walked too', () => {
  const p = page()
  p.start()
  p.document.addEventListener('keydown', (e) => e.preventDefault(), true)
  p.press('n')
  expect(p.walked).toEqual([])
})
