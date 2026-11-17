/**
 * Kick server-renders its chat input and hydrates it later; a pop-out window has the input in
 * its first html. The chat button went inside it before kick's React had hydrated it, which
 * broke the hydration: React #418 on every kick pop-out, the page redrawn client-side (11-16).
 * Runs the real injectButton from src/content/heatsync-button.js against kick's input before
 * and after its editor comes alive.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'heatsync-button.js'), 'utf8')
const s = SRC.indexOf('    function injectButton() {')
const BODY = SRC.slice(s, SRC.indexOf('\n    }\n', s) + 7)

function kickPopout(html) {
  const win = new Window({ url: 'https://kick.com/popout/somechannel/chat' })
  win.document.body.innerHTML = html
  const inject = new Function(
    'document',
    'window',
    'BUTTON_ID',
    'createButton',
    'log',
    'preloadEmotesInBackground',
    `let buttonInjected = false, emotesPreloaded = true, preloadingInProgress = false
     ${BODY}
     return injectButton`,
  )(
    win.document,
    win,
    'heatsync-chat-button',
    () => {
      const b = win.document.createElement('button')
      b.id = 'heatsync-chat-button'
      return b
    },
    () => {},
    () => {},
  )
  return { win, inject, button: () => win.document.getElementById('heatsync-chat-button') }
}

const INPUT = '<div class="relative w-full"><div class="editor-input" contenteditable="true"></div></div>'

test('the server-rendered input, not yet hydrated: no button inside it', () => {
  const k = kickPopout(INPUT)
  k.inject()
  expect(k.button()).toBeNull()
})

test('once kick drew its editor, the button lands beside it', () => {
  const k = kickPopout(INPUT)
  k.inject()
  k.win.document.querySelector('.editor-input').innerHTML = '<p class="editor-paragraph"><br></p>'
  k.inject()
  expect(k.button()?.parentElement?.className).toBe('relative w-full')
})

test('no editor at all: waits for next.js to have mounted its router', () => {
  const k = kickPopout('<div class="chat-footer"></div>')
  k.inject()
  expect(k.button()).toBeNull()
  k.win.document.body.appendChild(k.win.document.createElement('next-route-announcer'))
  k.inject()
  expect(k.button()?.parentElement?.className).toBe('chat-footer')
})
