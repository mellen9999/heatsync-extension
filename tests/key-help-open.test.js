/**
 * ? / ctrl+/ / f1 open the key help from anywhere on the page. `?` is a typed character, so it
 * is left alone while an input has focus; ctrl+/ and f1 type nothing and work from the composer.
 * Runs the real initKeyHelpKeys + ownKeyup on a real page; the help table itself is the one the
 * settings pane renders (tests/key-help.test.js).
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const dir = join(import.meta.dir, '..', 'src', 'multichat')
const KEYS = readFileSync(join(dir, 'overlay-keys.js'), 'utf8')

function page() {
  const window = new Window()
  const document = window.document
  const composer = document.createElement('input')
  document.body.appendChild(composer)
  const ctl = new window.AbortController()
  const api = new Function('document', 'window', `${KEYS}\nreturn { initKeyHelpKeys, isKeyHelpKey }`)(document, window)
  const opened = []
  let refuse = false
  api.initKeyHelpKeys(ctl.signal, (k) => {
    if (refuse) return false
    opened.push(k)
    return true
  })
  const press = (key, init = {}, target = document.body) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
  }
  return { composer, opened, press, refuse: () => (refuse = true), api }
}

test('? opens the help and the key is taken', () => {
  const p = page()
  expect(p.press('?', { shiftKey: true }).defaultPrevented).toBe(true)
  expect(p.opened).toEqual(['?'])
})

test('ctrl+/ and f1 open it', () => {
  const p = page()
  p.press('/', { ctrlKey: true })
  p.press('F1')
  expect(p.opened).toEqual(['/', 'F1'])
})

test('? typed in the composer is text, not a command; ctrl+/ and f1 still work there', () => {
  const p = page()
  expect(p.press('?', {}, p.composer).defaultPrevented).toBe(false)
  p.press('/', { ctrlKey: true }, p.composer)
  p.press('F1', {}, p.composer)
  expect(p.opened).toEqual(['/', 'F1'])
})

test('a bare / is not the help, nor is alt or meta or ctrl+?', () => {
  const p = page()
  p.press('/')
  p.press('F1', { altKey: true })
  p.press('?', { ctrlKey: true })
  p.press('?', { metaKey: true })
  expect(p.opened).toEqual([])
})

test('when the opener declines (already on the help), the key is not eaten', () => {
  const p = page()
  p.refuse()
  expect(p.press('F1').defaultPrevented).toBe(false)
})
