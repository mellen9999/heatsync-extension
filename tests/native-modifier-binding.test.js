/**
 * Twitch's and kick's own chat with the overlay off is drawn by content.js
 * (replaceEmotesWithStacking). It had its own idea of which emote a modifier word changes:
 * it reached back first, so `Kappa w! Keepo` widened Kappa there and Keepo in the overlay,
 * a word with no emote beside it left the line (`hello w!` read `hello`), and a word waited
 * over any text for a later emote (`w! hello Kappa`).
 *
 * It asks hsModBind now (content/native-emote-law.js, on lib/modifiers.js hsModSide). Here the real function, carved from the content
 * script, draws every line of shared/emote-mods.vectors.json.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { hsModBind } from '../src/content/native-emote-law.js'
import * as mods from '../src/lib/modifiers.js'

// native-emote-law.js is embedded into content.js beside the lib: it calls these as free names
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModSide = mods.hsModSide

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
const start = SRC.indexOf('  function replaceEmotesWithStacking(')
const end = SRC.indexOf('\n  }\n', start)
if (start === -1 || end === -1) throw new Error('replaceEmotesWithStacking carve markers not found')

const win = new Window()
const doc = win.document
const prefs = { emoteModifiers: true }
const EMOJI = new Map([['smile', { emoji: '😀' }]])
// an emote as a span that says what it was drawn with (the real builder needs the page)
const emoteEl = (emote, isOverlay, modifiers, hue) => {
  const el = doc.createElement('span')
  el.className = `heatsync-emote-wrapper${isOverlay ? ' heatsync-overlay' : ''}`
  el.dataset.name = emote.name
  el.dataset.fx = mods.hsModWordsFromState(modifiers || [], hue ?? null).join(' ')
  return el
}
const draw = new Function(
  'document',
  '_uiPrefs',
  'HS_WS_SPLIT',
  'UNICODE_EMOJI_RE',
  'EMOJI_BY_NAME',
  'hsModBind',
  'hsModClassify',
  'hsModComposeTransform',
  'hsModComposeFilter',
  'isZeroWidthEmote',
  'generateEmoteElement',
  't',
  'hsXify',
  'signal',
  'log',
  'requestAnimationFrame',
  `${SRC.slice(start, end + 4)}\nreturn replaceEmotesWithStacking`,
)(
  doc,
  prefs,
  /(\s+)/,
  /^[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍]+$/u,
  EMOJI,
  hsModBind,
  mods.hsModClassify,
  mods.hsModComposeTransform,
  mods.hsModComposeFilter,
  (name, e, all) => e?.zeroWidth === true || (name.endsWith('0') && !all.has(name)),
  emoteEl,
  (k) => k,
  () => {},
  undefined,
  () => {},
  () => {},
)

// what a line draws: each emote with the effects on it, emoji with their filter/transform, and the words left as text
function row(line, names) {
  const all = new Map(names.map((n) => [n, { name: n, zeroWidth: n.endsWith('0') }]))
  const el = doc.createElement('span')
  el.textContent = line
  doc.body.appendChild(el)
  draw(el, all)
  const emotes = [...el.querySelectorAll('.heatsync-emote-wrapper')].map((e) => ({
    name: e.dataset.name,
    fx: e.dataset.fx,
  }))
  const emoji = [...el.querySelectorAll('.heatsync-emoji')].map(
    (e) => `${e.textContent}:${/transform|filter/.test(e.style.cssText) ? 'changed' : ''}`,
  )
  for (const e of el.querySelectorAll(
    '.heatsync-emote-wrapper, .heatsync-emoji, .heatsync-stack-collapse, .heatsync-stack-block-all',
  ))
    e.remove()
  const text = (el.textContent || '').split(/\s+/).filter(Boolean)
  el.remove()
  return { emotes, emoji, text }
}

const V = JSON.parse(readFileSync(join(import.meta.dir, '..', 'shared', 'emote-mods.vectors.json'), 'utf8'))

describe('the native row draws every line of the shared rule', () => {
  for (const c of V.lines) {
    test(`${c.name}: ${JSON.stringify(c.line)}`, () => {
      const words = c.line.split(' ')
      // the binder on its own answers the row as written
      const bound = hsModBind(words, (i) => c.emotes.includes(words[i]))
      expect(Object.fromEntries(bound)).toEqual(
        Object.fromEntries(Object.entries(c.want).map(([k, v]) => [Number(k), v])),
      )

      const got = row(c.line, c.emotes)
      const wantEmotes = words
        .map((w, i) => ({ w, i }))
        .filter(({ w, i }) => c.emotes.includes(w) && !bound.has(i))
        .map(({ w, i }) => {
          const parts = [...bound].filter(([, to]) => to === i).map(([k]) => mods.hsModClassify(words[k]))
          const hue = parts.reduce((h, p) => (p.hue != null ? p.hue : h), null)
          return {
            name: w.endsWith('0') && !c.emotes.includes(w) ? w.slice(0, -1) : w,
            fx: mods
              .hsModWordsFromState(
                parts.flatMap((p) => p.mods || []),
                hue,
              )
              .join(' '),
          }
        })
      expect(got.emotes).toEqual(wantEmotes)
      expect(got.text).toEqual(words.filter((w, i) => w && !bound.has(i) && !c.emotes.includes(w)))
    })
  }
})

describe('what this row used to do', () => {
  const ROOM = ['Kappa', 'Keepo']
  test('`Kappa w! Keepo` widens Keepo, as in the overlay', () => {
    expect(row('Kappa w! Keepo', ROOM).emotes).toEqual([
      { name: 'Kappa', fx: '' },
      { name: 'Keepo', fx: 'w!' },
    ])
  })
  test('a word with no emote beside it stays on the line', () => {
    expect(row('hello w!', ROOM)).toEqual({ emotes: [], emoji: [], text: ['hello', 'w!'] })
  })
  test('a word never waits over text for a later emote', () => {
    expect(row('w! hello Kappa', ROOM)).toEqual({
      emotes: [{ name: 'Kappa', fx: '' }],
      emoji: [],
      text: ['w!', 'hello'],
    })
  })
  test('an emoji takes a word typed after it and is never reached for', () => {
    expect(row('😀 ffzX', ROOM)).toEqual({ emotes: [], emoji: ['😀:changed'], text: [] })
    expect(row(':smile: w!', ROOM)).toEqual({ emotes: [], emoji: ['😀:changed'], text: [] })
    expect(row('ffzX 😀', ROOM)).toEqual({ emotes: [], emoji: ['😀:'], text: ['ffzX'] })
  })
  test('with modifiers switched off every word is a word', () => {
    prefs.emoteModifiers = false
    try {
      expect(row('Kappa w!', ROOM)).toEqual({ emotes: [{ name: 'Kappa', fx: '' }], emoji: [], text: ['w!'] })
    } finally {
      prefs.emoteModifiers = true
    }
  })
})
