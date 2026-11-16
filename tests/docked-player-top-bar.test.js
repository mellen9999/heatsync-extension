/**
 * With chat docked, the player is sized into what is left below the host's fixed top bar. Kick
 * keeps a zero-size twin of its bar ahead of the real one, and youtube's bar was never counted:
 * both players came out a bar too tall, the bottom 56-60px (the controls) under a bottom-docked
 * panel (s7 docked, 11-16). Runs the real hostTopBarBottom from src/multichat/chat-position.js.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-position.js'), 'utf8')
const s = SRC.indexOf('function hostTopBarBottom(')
const BODY = SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)

let win
afterEach(() => win?.happyDOM.close())

/** Elements with the boxes the browser would give them (happy-dom does no layout). */
function page(html, boxes) {
  win = new Window()
  win.document.body.innerHTML = html
  for (const [id, r] of Object.entries(boxes))
    win.document.getElementById(id).getBoundingClientRect = () => ({ ...r, bottom: r.top + r.height })
  return new Function('document', `${BODY}\nreturn hostTopBarBottom`)(win.document)
}

test('kick: the drawn bar counts, not the zero-size twin ahead of it', () => {
  const bar = page('<nav id="twin"></nav><nav id="real"></nav><div id="z" class="sticky z-navbar"></div>', {
    twin: { top: 0, height: 0 },
    real: { top: 0, height: 60 },
    z: { top: 0, height: 0 },
  })
  expect(bar('nav, [class*="navbar"]')).toBe(60)
})

test('youtube: the masthead holds the first 56px', () => {
  const bar = page('<div id="masthead-container"></div>', { 'masthead-container': { top: 0, height: 56 } })
  expect(bar('#masthead-container')).toBe(56)
})

test('a bar that is hidden (fullscreen) or not at the top takes no room', () => {
  const bar = page('<div id="masthead-container"></div><nav id="low"></nav>', {
    'masthead-container': { top: 0, height: 0 },
    low: { top: 400, height: 48 },
  })
  expect(bar('#masthead-container')).toBe(0)
  expect(bar('nav')).toBe(0)
})
