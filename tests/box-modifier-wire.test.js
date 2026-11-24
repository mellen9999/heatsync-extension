/**
 * The box is the row. A chip that shows a modified emote must go out as words every app
 * reads back onto THAT emote (shared/emote-mods.vectors.json is the rule): a betterttv-shaped
 * word changes the emote after it, so a widened Kappa written `Kappa w!` and followed by
 * another emote widened that one for everyone reading the line. The chip writes `w! Kappa`;
 * a frankerfacez word stays after its emote.
 *
 * The real getInputText (carved from the content-script source) writes the line, and the
 * real row renderer reads it back.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'

Object.assign(globalThis, mods)
globalThis.escapeHtml = escapeHtml
globalThis.unescapeHtml = unescapeHtml
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined
globalThis.t = (k) => k
globalThis.hsXButtonHtml = () => ''

const { processEmotes, channelEmoteCaches } = await import('../src/multichat/emotes.js')

const INPUT = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
function fn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}', start) + 2)
}

const win = new Window()
const doc = win.document
const getInputText = new Function(
  'document',
  'Node',
  'hsModChipText',
  `const wysiwygEnabled = true
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI'])
const oneLine = (s) => s.replace(/\\s*\\n\\s*/g, ' ').trim()
${fn(INPUT, 'getInputText')}
return getInputText`,
)(doc, win.Node, mods.hsModChipText)
const chipToText = new Function('Node', 'hsModChipText', `${fn(INPUT, 'chipToText')}\nreturn chipToText`)(
  win.Node,
  mods.hsModChipText,
)

const ROOM = ['Kappa', 'Keepo', 'Rain0']
const chip = (name, words = '') =>
  `<img class="hs-input-emote${name.endsWith('0') ? ' hs-input-overlay' : ''}" alt="${name}" data-emote-name="${name}"${words ? ` data-hs-words="${words}"` : ''}>`
const stack = (...units) => `<span class="hs-input-stack" contenteditable="false">${units.join('')}</span>`
function box(html) {
  doc.body.innerHTML = `<div id="hs-mc-input" contenteditable="true">${html}</div>`
  return doc.getElementById('hs-mc-input')
}
// the emotes the box shows, each with the effects of its words (one spelling per effect, as a row stamps them)
const fxOf = (words) => {
  const parts = words
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => mods.hsModClassify(w))
  return mods
    .hsModWordsFromState(
      parts.flatMap((p) => p.mods || []),
      null,
    )
    .sort()
    .join(' ')
}
const shown = (input) =>
  [...input.querySelectorAll('img.hs-input-emote')].map(
    (img) => `${img.dataset.emoteName}:${fxOf(img.dataset.hsWords || '')}`,
  )
// the same reading of the row a line draws
function row(line) {
  channelEmoteCaches['chan-x'] = new Map(
    ROOM.map((n) => [
      n,
      { url: `https://cdn.7tv.app/emote/${n}/1x.webp`, source: '7tv', state: 'channel', zeroWidth: n.endsWith('0') },
    ]),
  )
  try {
    const root = doc.createElement('div')
    root.innerHTML = processEmotes(escapeHtml(line), 'chan-x', null, null, null)
    return [...root.querySelectorAll('.hs-mc-emote-wrapper[data-emote-name]')].map(
      (el) => `${el.dataset.emoteName}:${(el.dataset.hsMods || '').split(' ').filter(Boolean).sort().join(' ')}`,
    )
  } finally {
    delete channelEmoteCaches['chan-x']
  }
}

describe('a chip writes its words where they stay its own', () => {
  test('betterttv-shaped words before the name, frankerfacez ones after', () => {
    expect(mods.hsModChipText('Kappa', 'w!')).toBe('w! Kappa')
    expect(mods.hsModChipText('Kappa', 'ffzX')).toBe('Kappa ffzX')
    expect(mods.hsModChipText('Kappa', 'w! ffzX c!#ff0000 h!')).toBe('w! c!#ff0000 h! Kappa ffzX')
    expect(mods.hsModChipText('Kappa', '')).toBe('Kappa')
    expect(mods.hsModChipText('Kappa', undefined)).toBe('Kappa')
  })
  test('an emote whose own name is a modifier word keeps its words after it', () => {
    expect(mods.hsModChipText('ffzX', 'w!')).toBe('ffzX w!')
  })
  test('the reported shape: a widened Kappa, then Keepo, goes out as `w! Kappa Keepo`', () => {
    const input = box(`${chip('Kappa', 'w!')} ${chip('Keepo')}`)
    expect(getInputText()).toBe('w! Kappa Keepo')
    expect(row(getInputText())).toEqual(shown(input))
  })
  test('a chip unwrapped back to text is the same words', () => {
    const input = box(chip('Kappa', 'w! ffzX'))
    expect(chipToText(input.firstChild)).toBe('w! Kappa ffzX ')
  })
})

describe('the row draws what the box shows', () => {
  const layouts = {
    'wide then plain': `${chip('Kappa', 'w!')} ${chip('Keepo')}`,
    'plain then wide': `${chip('Kappa')} ${chip('Keepo', 'w!')}`,
    'flipped (ffz) then plain': `${chip('Kappa', 'ffzX')} ${chip('Keepo')}`,
    'plain then flipped (ffz)': `${chip('Kappa')} ${chip('Keepo', 'ffzX')}`,
    'both changed, both ways': `${chip('Kappa', 'w! ffzX')} ${chip('Keepo', 'h! ffzY')}`,
    'text between': `${chip('Kappa', 'w!')} hello ${chip('Keepo', 'ffzX')}`,
    'three in a row, the middle one changed': `${chip('Kappa')} ${chip('Keepo', 'w! ffzX')} ${chip('Kappa')}`,
    'an overlay in a stack carries its own': `${stack(chip('Kappa', 'ffzX'), chip('Rain0', 'ffzW'))} ${chip('Keepo')}`,
  }
  for (const [name, html] of Object.entries(layouts)) {
    test(name, () => {
      const input = box(html)
      expect(row(getInputText())).toEqual(shown(input))
    })
  }
})
