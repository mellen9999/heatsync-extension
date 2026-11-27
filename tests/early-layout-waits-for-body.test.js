/**
 * early-layout.js runs at document_start, before <body> exists, and puts the layout classes on it
 * the moment it appears. <body> is a direct child of <html>, so it waits there for a child and
 * nothing more: with `subtree` it was handed a record for every node the page drew inside <body>
 * until it found one (or 5 seconds went by).
 *
 * The REAL file runs in happy-dom with the body taken away, the way a document_start page is.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

const SRC = readFileSync(new URL('../src/content/early-layout.js', import.meta.url), 'utf8')

let win
afterEach(() => win?.close?.())

/** a page at document_start: <html> and <head>, no <body> yet. `seen` records every observe() call */
function start(url) {
  win = new Window({ url })
  const document = win.document
  document.body.remove()
  const seen = []
  class SpyObserver extends win.MutationObserver {
    observe(target, opts) {
      seen.push({ target, opts })
      return super.observe(target, opts)
    }
  }
  win.localStorage.setItem('hs_layout_chatPosition', '"left"')
  const timers = []
  new Function(
    'window',
    'document',
    'location',
    'localStorage',
    'sessionStorage',
    'MutationObserver',
    'setTimeout',
    SRC,
  )(
    win,
    document,
    win.location,
    win.localStorage,
    win.sessionStorage,
    SpyObserver,
    (fn, ms) => timers.push([fn, ms]) && 0,
  )
  return { document, seen, timers }
}

const body = (document) => {
  const b = document.createElement('body')
  document.documentElement.appendChild(b)
  return b
}
const tick = () => new Promise((r) => setTimeout(r, 5))

test('the layout classes land on a body that arrives late', async () => {
  const { document } = start('https://www.twitch.tv/xqc')
  expect(document.body).toBeNull()
  const b = body(document)
  await tick()
  expect(b.classList.contains('hs-platform-twitch')).toBe(true)
  expect(b.classList.contains('hs-chat-left')).toBe(true)
  expect(b.classList.contains('hs-tabs-top')).toBe(true)
})

test('it waits for a child of <html> and nothing deeper, and lets go once it has the body', async () => {
  const { document, seen } = start('https://www.twitch.tv/xqc')
  const waits = seen.filter((s) => s.target === document.documentElement)
  expect(waits.length).toBe(1)
  expect(waits[0].opts.childList).toBe(true)
  expect(waits[0].opts.subtree).toBeFalsy()
  expect(seen.length).toBe(1)

  // once the body is in, what the page draws inside it must not reach the callback again
  const b = body(document)
  await tick()
  b.classList.remove('hs-platform-twitch')
  b.appendChild(document.createElement('div'))
  await tick()
  expect(b.classList.contains('hs-platform-twitch')).toBe(false)
})

test('a page that already has its body needs no watch at all', () => {
  win = new Window({ url: 'https://www.twitch.tv/xqc' })
  const seen = []
  class SpyObserver extends win.MutationObserver {
    observe(target, opts) {
      seen.push({ target, opts })
      return super.observe(target, opts)
    }
  }
  new Function(
    'window',
    'document',
    'location',
    'localStorage',
    'sessionStorage',
    'MutationObserver',
    'setTimeout',
    SRC,
  )(win, win.document, win.location, win.localStorage, win.sessionStorage, SpyObserver, () => 0)
  expect(win.document.body.classList.contains('hs-platform-twitch')).toBe(true)
  expect(seen).toEqual([])
})
