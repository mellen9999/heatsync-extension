/**
 * A word left in the box when you change tabs is read against the tab it will be sent in.
 * The box kept the last channel's picture while the line shipped the new channel's emote of
 * that name, and a word that is an emote only in the tab you left stayed a picture and went
 * out as text. rereadInputChips is carved from the real source; the room is a stub map.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { hsModChipText } from '../src/lib/modifiers.js'

// input.js is concatenated beside lib/modifiers.js: a chip's words are written by its helper
globalThis.hsModChipText = hsModChipText

const ROOT = join(import.meta.dir, '..')
const read = (f) => readFileSync(join(ROOT, 'src', 'multichat', f), 'utf8')
const INPUT = read('input.js')

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}', start) + 2)
}

const win = new Window()
const doc = win.document
// what a word is in the open tab: name -> picture url (the law's answer, stubbed)
let room = {}
const createInputEmoteImg = (name) => {
  if (!room[name]) return null
  const img = doc.createElement('img')
  img.className = 'hs-input-emote'
  img.src = room[name]
  img.alt = name
  img.dataset.emoteName = name
  return img
}
const reread = new Function(
  'document',
  'Node',
  'createInputEmoteImg',
  'lookupEmoteWithOverlay',
  'emoteIsBlocked',
  'lookupEmoteRenderOrder',
  'blockedEmoteNames',
  `${fn(INPUT, 'chipToText')}
${fn(INPUT, 'imagifyValidWordsInTextNode')}
${fn(read('emote-law-send.js'), 'rereadInputChips')}
return rereadInputChips`,
)(
  doc,
  win.Node,
  createInputEmoteImg,
  (n) => (room[n] ? { emote: { url: room[n] } } : null),
  () => false,
  () => null,
  new Set(),
)

const chip = (name, src) => `<img class="hs-input-emote" src="${src}" alt="${name}" data-emote-name="${name}">`
function box(html) {
  doc.body.innerHTML = `<div id="hs-mc-input" contenteditable="true">${html}</div>`
  const el = doc.getElementById('hs-mc-input')
  // happy-dom has no isContentEditable
  Object.defineProperty(el, 'isContentEditable', { value: true })
  return el
}
const words = (el) =>
  [...el.childNodes]
    .map((n) => (n.dataset?.emoteName ? `<${n.dataset.emoteName}=${n.getAttribute('src')}>` : n.textContent))
    .join('')

describe('changing tabs reads the box again', () => {
  test("a word both channels have takes the new channel's picture", () => {
    const el = box(`hi ${chip('KEKW', 'a.png')} there`)
    room = { KEKW: 'b.png' }
    reread()
    expect(words(el)).toBe('hi <KEKW=b.png> there')
  })
  test('a word that is no emote in the new channel is text again', () => {
    const el = box(`hi ${chip('OnlyA', 'a.png')} there`)
    room = {}
    reread()
    expect(words(el)).toBe('hi OnlyA there')
    expect(el.querySelector('img')).toBeNull()
  })
  test('a plain word is left alone: as you type, only Tab and your own set draw', () => {
    const el = box('hi OnlyB there')
    room = { OnlyB: 'b.png' }
    reread()
    expect(words(el)).toBe('hi OnlyB there')
  })
  test('a stack whose picture changed goes back to its words, drawn as they are here', () => {
    const el = box(`<span class="hs-input-stack">${chip('KEKW', 'a.png')}${chip('Wave', 'w.png')}</span> x`)
    room = { KEKW: 'b.png', Wave: 'w.png' }
    reread()
    expect(words(el)).toBe('<KEKW=b.png> <Wave=w.png> x')
  })
  test('a chip whose answer is the same picture (a pick, or the same emote) is left alone', () => {
    const el = box(`${chip('KEKW', 'a.png')} `)
    const before = el.querySelector('img')
    room = { KEKW: 'a.png' }
    reread()
    expect(el.querySelector('img')).toBe(before)
  })
  test('an empty box is left alone', () => {
    const el = box('')
    room = { KEKW: 'b.png' }
    reread()
    expect(el.childNodes.length).toBe(0)
  })
})

describe("the open tab's emotes changing under the box", () => {
  test('a chip follows its picture', () => {
    const el = box(`${chip('KEKW', 'a.png')} lol`)
    room = { KEKW: 'b.png' }
    reread()
    expect(words(el)).toBe('<KEKW=b.png> lol')
  })
  test('a removed emote is text again', () => {
    const el = box(`${chip('KEKW', 'a.png')} lol`)
    room = {}
    reread()
    expect(words(el)).toBe('KEKW lol')
  })
  test('a half-typed word is never turned into a picture', () => {
    const el = box('typing LUL')
    room = { LUL: 'b.png' }
    reread()
    expect(words(el)).toBe('typing LUL')
  })
})

describe('wiring', () => {
  test('a tab switch reads the box, once the tab is the open one', () => {
    expect(read('main-tabs.js')).toMatch(/updateInputPlaceholder\(\)\n\s*\/\/[^\n]*\n\s*rereadInputChips\(\)/)
  })
  test('an emote load reads the box too', () => {
    expect(read('main-storage.js')).toMatch(/reloadEmotesInPlace\(\)\n[^\n]*\n\s*rereadInputChips\(\)/)
  })
})
