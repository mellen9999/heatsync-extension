import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

/**
 * "copy message" and "quote" read a row's text by walking what follows the name. The row's own
 * thread button (») sits there too and was not on the skip list, so every copied message ended
 * in " »" (e2e s23, 11-17). The walker runs for real on a row built the way the renderer does.
 */
const INPUT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const s = INPUT.indexOf('const MC_ROW_FURNITURE =')
const { _extractMcMsgText } = new Function(
  `${INPUT.slice(s, INPUT.indexOf('\nfunction _prefillMcInput(text) {', s))}\nreturn { _extractMcMsgText }`,
)()

function row(build) {
  const doc = new Window().document
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  const msg = el('div', 'hs-mc-msg')
  msg.append(el('span', 'hs-mc-time', '12:01'), el('span', 'hs-mc-badge', 'M'), el('a', 'hs-mc-user', 'alice'))
  build(msg, el, doc)
  doc.body.appendChild(msg)
  return msg
}

test('the thread button is not part of the message', () => {
  const msg = row((m, el) => {
    m.append(': ', el('span', 'hs-mc-text', 'hello world'), el('button', 'hs-mc-thread-btn', '»'))
  })
  expect(_extractMcMsgText(msg)).toBe('hello world')
})

test('a » the chatter typed is kept', () => {
  const msg = row((m, el) => {
    m.append(': ', el('span', 'hs-mc-text', 'look » here »'), el('button', 'hs-mc-thread-btn', '»'))
  })
  expect(_extractMcMsgText(msg)).toBe('look » here »')
})

test('emotes copy as their names, in place, and row furniture stays out', () => {
  const msg = row((m, el, doc) => {
    const text = el('span', 'hs-mc-text')
    const emote = doc.createElement('img')
    emote.alt = 'Kappa'
    text.append(emote, ' nice one ')
    m.append(
      ': ',
      text,
      el('span', 'hs-mod-toolbar', 'ban'),
      el('button', 'hs-mc-stack-collapse', '-'),
      el('button', 'hs-mc-thread-btn', '»'),
    )
  })
  expect(_extractMcMsgText(msg)).toBe('Kappa nice one')
})
