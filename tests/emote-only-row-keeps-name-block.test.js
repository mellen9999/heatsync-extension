/**
 * Native mode: an emote blocked by name is marked in every row. processMessage did that as its
 * last step, after "this row has no text element: nothing to do" — and a line that is only
 * emotes has no text element. Every emote-only line that arrived after the block drew the
 * emote unblocked (real twitch, two tabs, e2e s24, 11-18).
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
const carve = (name) => {
  const a = SRC.indexOf(`  function ${name}(`)
  const b = SRC.indexOf('\n  }\n', a)
  if (a < 0 || b < 0) throw new Error(`carve: ${name}`)
  return SRC.slice(a, b + 5)
}

let win
afterEach(() => win?.happyDOM.close())

function row(html) {
  win = new Window()
  win.document.body.innerHTML = `<div class="chat-line__message">${html}</div>`
  return win.document.querySelector('.chat-line__message')
}
const mark = (el, names) =>
  new Function(
    'localBlockedEmoteNames',
    'NATIVE_EMOTE_IMG',
    `${carve('markBlockedNativeEmotes')}\nreturn markBlockedNativeEmotes`,
  )(
    new Set(names),
    'img[src*="static-cdn.jtvnw.net/emoticons"], img[src*="files.kick.com/emotes/"]',
  )(el)
const EMOTE = (alt) => `<img src="https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/1.0" alt="${alt}">`

test('a line that is only emotes gets its blocked one marked', () => {
  const el = row(`${EMOTE('alanzD')} ${EMOTE('Kappa')}`)
  expect(el.querySelector('.text-fragment')).toBe(null)
  mark(el, ['alanzD'])
  const [a, b] = el.querySelectorAll('img')
  expect(a.getAttribute('data-hs-name-blocked')).toBe('1')
  expect(b.hasAttribute('data-hs-name-blocked')).toBe(false)
})

test('no blocked names: nothing is touched', () => {
  const el = row(EMOTE('alanzD'))
  mark(el, [])
  expect(el.querySelector('img').hasAttribute('data-hs-name-blocked')).toBe(false)
})

test('processMessage marks before it can leave for want of a text element', () => {
  const a = SRC.indexOf('  function processMessage(messageElement) {')
  const body = SRC.slice(a, SRC.indexOf('\n  }\n', a))
  const markAt = body.indexOf('markBlockedNativeEmotes(messageElement)')
  const outAt = body.indexOf('if (textElements.length === 0) return')
  expect(markAt).toBeGreaterThan(0)
  expect(outAt).toBeGreaterThan(markAt)
})
