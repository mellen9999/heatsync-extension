import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * A letter pressed while reading our chat goes into the composer. The site under us binds single
 * letters on its player (k and space pause, m mutes, f is fullscreen), and its listeners heard
 * the same key: with the pointer over chat, `k` paused the stream on twitch and kick, and on
 * twitch the letter was not typed either (e2e s22, 11-17). The key is now taken on the root
 * element, in the capture phase: after our own capture handlers (which may claim it first),
 * before every listener the host has on the way back up. The real module runs on a real page
 * with real key events.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'type-to-focus.js'), 'utf8')

function page({ popout = true } = {}) {
  const window = new Window()
  const document = window.document
  const composer = document.createElement('input')
  composer.id = 'hs-mc-input'
  document.body.appendChild(composer)
  if (popout) document.body.classList.add('hs-popout') // the panel is the window: attention is ours
  const heard = []
  const host = (where) => (e) => heard.push(`${where}:${e.key}${e.defaultPrevented ? ':prevented' : ''}`)
  const ctl = new window.AbortController()
  const { initTypeToFocus } = new Function(
    'document',
    'window',
    'Event',
    `${SRC.replace('export function', 'function')}\nreturn { initTypeToFocus }`,
  )(document, window, window.Event)
  const press = (key, target = document.body, init = {}) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
  }
  return { window, document, composer, heard, host, press, start: () => initTypeToFocus(ctl.signal) }
}

test('the letter is typed and no listener of the host on the way up hears it', () => {
  const p = page()
  // the host was there first, everywhere a player shortcut can sit
  p.document.body.addEventListener('keydown', p.host('body'))
  p.document.addEventListener('keydown', p.host('document'))
  p.window.addEventListener('keydown', p.host('window'))
  p.start()
  const e = p.press('k')
  expect(p.composer.value).toBe('k')
  expect(p.document.activeElement).toBe(p.composer)
  expect(e.defaultPrevented).toBe(true)
  expect(p.heard).toEqual([])
})

test('the player itself had focus: its own listener does not hear the key either', () => {
  const p = page()
  const player = p.document.createElement('div')
  player.tabIndex = 0
  p.document.body.appendChild(player)
  player.addEventListener('keydown', p.host('player'))
  player.addEventListener('keydown', p.host('player-capture'), true)
  p.start()
  player.focus()
  p.press(' ', player)
  expect(p.composer.value).toBe(' ')
  expect(p.heard).toEqual([])
})

test('one of our own capture handlers claimed the key first: nothing is typed', () => {
  const p = page()
  p.start()
  // vi mode's i / a, the hide key, row mode: capture on window or document, registered whenever
  p.document.addEventListener('keydown', (e) => e.key === 'i' && e.preventDefault(), true)
  p.window.addEventListener('keydown', (e) => e.key === '\\' && e.preventDefault(), true)
  p.press('i')
  p.press('\\')
  expect(p.composer.value).toBe('')
  p.press('x')
  expect(p.composer.value).toBe('x')
})

test('attention is on the host page: the key is the host’s, untouched', () => {
  const p = page({ popout: false })
  p.document.addEventListener('keydown', p.host('document'))
  p.start()
  const e = p.press('k')
  expect(p.composer.value).toBe('')
  expect(e.defaultPrevented).toBe(false)
  expect(p.heard).toEqual(['document:k'])
})

test('shortcuts, named keys and a field that is already taking text are left alone', () => {
  const p = page()
  p.document.addEventListener('keydown', p.host('document'))
  p.start()
  p.press('k', p.document.body, { ctrlKey: true })
  p.press('Escape')
  const other = p.document.createElement('textarea')
  p.document.body.appendChild(other)
  other.focus()
  p.press('k', other)
  expect(p.composer.value).toBe('')
  expect(p.heard).toEqual(['document:k', 'document:Escape', 'document:k'])
})

// A control of ours with the focus handles its own keys, below the root on the event's path
// (tour.js tourOnKey, pin-bar.js pinOnKey, the reply pill). Taking the key on the root first
// typed a space into the composer and the focused tour switch never flipped (render check, 11-18).
function panelWith(p) {
  const panel = p.document.createElement('div')
  panel.id = 'hs-mc-container'
  const control = p.document.createElement('button')
  panel.appendChild(control)
  p.document.body.appendChild(panel)
  return { panel, control }
}

test('a focused control of ours that claims the key gets it: nothing is typed, the host hears nothing', () => {
  const p = page()
  const { control } = panelWith(p)
  let flipped = 0
  control.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return
    e.preventDefault()
    flipped++
  })
  p.document.body.addEventListener('keydown', p.host('body'))
  p.document.addEventListener('keydown', p.host('document'))
  p.window.addEventListener('keydown', p.host('window'))
  p.start()
  control.focus()
  p.press(' ', control)
  expect(flipped).toBe(1)
  expect(p.composer.value).toBe('')
  expect(p.document.activeElement).toBe(control)
  expect(p.heard).toEqual([])
})

test('a focused control of ours that does not want the key: it is typed, and the host hears nothing', () => {
  const p = page()
  const { control } = panelWith(p)
  control.addEventListener('keydown', (e) => e.key === ' ' && e.preventDefault())
  p.document.body.addEventListener('keydown', p.host('body'))
  p.document.addEventListener('keydown', p.host('document'))
  p.start()
  control.focus()
  const e = p.press('k', control)
  expect(p.composer.value).toBe('k')
  expect(p.document.activeElement).toBe(p.composer)
  expect(e.defaultPrevented).toBe(true)
  expect(p.heard).toEqual([])
})

test('a control that ends the key itself leaves nothing behind for the next key', () => {
  const p = page()
  const { control } = panelWith(p)
  control.addEventListener('keydown', (e) => {
    if (e.key !== 'y') return
    e.preventDefault()
    e.stopPropagation()
  })
  p.start()
  control.focus()
  p.press('y', control)
  expect(p.composer.value).toBe('')
  // the next key, from the page body, is typed once
  control.blur()
  p.press('a')
  expect(p.composer.value).toBe('a')
})
