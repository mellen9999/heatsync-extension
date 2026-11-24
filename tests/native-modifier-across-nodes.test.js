/**
 * On twitch's and kick's own chat a platform emote is its own dom node, so a modifier word
 * beside it (`<Kappa> ffzX`, `w! <Kappa>`) is alone in its text run. content.js reads the whole
 * message once more as one line (applyModifiersAcrossMessage) and binds what is left by the
 * rule every app runs (hsModBind; shared/emote-mods.vectors.json).
 *
 * It used to reach back only, never took the word off the line, and before that the row drawer
 * swallowed the word so nothing happened at all. The real function, carved from the content
 * script, on real dom shapes.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { hsModBind } from '../src/content/native-emote-law.js'
import * as mods from '../src/lib/modifiers.js'

globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModSide = mods.hsModSide

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'content.js'), 'utf8')
const start = SRC.indexOf('  const HS_NATIVE_EMOTE_SEL =')
const fnAt = SRC.indexOf('  function applyModifiersAcrossMessage(', start)
const end = SRC.indexOf('\n  }\n', fnAt)
if (start === -1 || fnAt === -1 || end === -1) throw new Error('applyModifiersAcrossMessage carve markers not found')

const win = new Window()
const doc = win.document
const across = new Function(
  'document',
  'NodeFilter',
  'HS_WS_SPLIT',
  'hsModBind',
  'hsModClassify',
  'hsModComposeTransform',
  'hsModTransformStr',
  `${SRC.slice(start, end + 4)}\nreturn applyModifiersAcrossMessage`,
)(doc, win.NodeFilter, /(\s+)/, hsModBind, mods.hsModClassify, mods.hsModComposeTransform, mods.hsModTransformStr)

const TW = (alt) =>
  `<img class="chat-image" alt="${alt}" src="https://static-cdn.jtvnw.net/emoticons/v2/${alt}/default/dark/1.0">`
const frag = (t) => `<span class="text-fragment">${t}</span>`
const OURS = (name) =>
  `<span class="heatsync-emote-wrapper"><img alt="${name}" src="https://cdn.heatsync.org/emote/${name}.png"></span>`
function message(body, name = 'alice') {
  doc.body.innerHTML = `<div class="chat-line__message"><span class="chat-author__display-name">${name}</span><span>: </span>${body}</div>`
  const el = doc.body.firstElementChild
  across(el)
  return el
}
// each emote of the message with the transform it carries, and the words of its text runs
const read = (el) => ({
  emotes: [...el.querySelectorAll('img')].map((i) => {
    const own = i.closest('.heatsync-emote-wrapper')
    return `${i.alt}:${(own || i).style.transform || ''}`
  }),
  text: [...el.querySelectorAll('.text-fragment, .hs-textfrag')]
    .map((f) =>
      [...f.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.nodeValue)
        .join(''),
    )
    .join('|'),
})

describe("a word beside the platform's own emote", () => {
  test('a frankerfacez word after it flips it, and leaves the line', () => {
    expect(read(message(`${frag('hello ')}${TW('Kappa')}${frag(' ffzX then')}`))).toEqual({
      emotes: ['Kappa:scale(-1, 1)'],
      text: 'hello | then',
    })
  })
  test('a betterttv word before it widens it', () => {
    expect(read(message(`${frag('hello w! ')}${TW('Kappa')}`))).toEqual({
      emotes: ['Kappa:scale(2, 1)'],
      text: 'hello ',
    })
  })
  test('between two, a betterttv word takes the one after and a frankerfacez word the one before', () => {
    expect(read(message(`${TW('Kappa')}${frag(' w! ')}${TW('Keepo')}`)).emotes).toEqual(['Kappa:', 'Keepo:scale(2, 1)'])
    expect(read(message(`${TW('Kappa')}${frag(' ffzX ')}${TW('Keepo')}`)).emotes).toEqual([
      'Kappa:scale(-1, 1)',
      'Keepo:',
    ])
  })
  test('with no emote after it a betterttv word falls back to the one before', () => {
    expect(read(message(`${TW('Kappa')}${frag(' w! l!')}`))).toEqual({
      emotes: ['Kappa:scale(2, 1) rotate(-90deg)'],
      text: '',
    })
  })
  test('never over text: the word stays where it was typed', () => {
    expect(read(message(`${TW('Kappa')}${frag(' hello w!')}`))).toEqual({ emotes: ['Kappa:'], text: ' hello w!' })
    expect(read(message(`${frag('w! hello ')}${TW('Kappa')}`))).toEqual({ emotes: ['Kappa:'], text: 'w! hello ' })
  })
  test('an emote this page drew is an emote on the line too', () => {
    const el = message(`${frag(OURS('Wave'))}${frag(' ffzX')}`)
    expect(read(el)).toEqual({ emotes: ['Wave:scale(-1, 1)'], text: '|' })
    expect(el.querySelector('.heatsync-emote-wrapper').classList.contains('heatsync-mod-flipH')).toBe(true)
  })
  test("kick's shape: its emote beside our span of its text", () => {
    doc.body.innerHTML =
      '<div data-index="1"><button class="inline font-bold">bob</button><span>: </span><span class="font-normal"><span class="hs-textfrag">w! </span><img alt="kekw" src="https://files.kick.com/emotes/37226/fullsize"><span class="hs-textfrag"> ffzY done</span></span></div>'
    const el = doc.body.firstElementChild
    across(el)
    expect(read(el)).toEqual({ emotes: ['kekw:scale(2, -1)'], text: '| done' })
  })
})

describe("the platform's own words are never read as modifiers, and never changed", () => {
  test('a chatter named ffzX, right before an emote', () => {
    doc.body.innerHTML = `<div class="chat-line__message"><span class="chat-author__display-name">ffzX</span>${TW('Kappa')}${frag(' hi')}</div>`
    const el = doc.body.firstElementChild
    across(el)
    expect(el.querySelector('.chat-author__display-name').textContent).toBe('ffzX')
    expect(read(el).emotes).toEqual(['Kappa:'])
  })
  test('a link or a mention between a word and an emote ends the reach', () => {
    const el = message(`${TW('Kappa')}<a class="link-fragment">w!</a>${frag(' ffzX')}`)
    expect(read(el)).toEqual({ emotes: ['Kappa:'], text: ' ffzX' })
    expect(el.querySelector('a').textContent).toBe('w!')
  })
  test('a badge is no emote', () => {
    const el = message(
      `${frag('w! ')}<img class="chat-badge" alt="Moderator" src="https://static-cdn.jtvnw.net/badges/v1/x/1">${frag('hello')}`,
    )
    expect(read(el).text).toBe('w! |hello')
  })
})

describe('run again on the same message', () => {
  test('nothing is added twice and no more words are taken', () => {
    const el = message(`${TW('Kappa')}${frag(' w! then')}`)
    const once = read(el)
    across(el)
    across(el)
    expect(read(el)).toEqual(once)
    expect(once).toEqual({ emotes: ['Kappa:scale(2, 1)'], text: ' then' })
  })
  test('a message with no modifier in it is not walked', () => {
    const el = message(`${TW('Kappa')}${frag(' hello')}`)
    expect(read(el)).toEqual({ emotes: ['Kappa:'], text: ' hello' })
  })
})

// Every line of the vector file whose emotes the platform could have issued (plain names: not an
// overlay, not a name shaped like a modifier), drawn the way twitch draws it: each emote its own
// node, the words between them in text runs. The whole-message pass alone must give the rule's
// answer, whichever of the emotes are the platform's.
describe("the vector file, with the platform's own emotes", () => {
  const V = JSON.parse(readFileSync(join(import.meta.dir, '..', 'shared', 'emote-mods.vectors.json'), 'utf8'))
  const isMod = (w) => mods.hsModClassify(w).kind === 'modifier'
  const plain = (name) => !isMod(name) && !name.endsWith('0')
  const lines = V.lines.filter((c) => c.line.split(' ').every((w) => !c.emotes.includes(w) || plain(w)))
  test('enough lines qualify to mean something', () => {
    expect(lines.length).toBeGreaterThan(80)
  })
  for (const c of lines) {
    test(`${c.name}: ${JSON.stringify(c.line)}`, () => {
      const words = c.line.split(' ')
      // twitch's shape: an emote is a node, a run of words between two emotes is one text fragment
      let body = ''
      let run = []
      const flush = (edge) => {
        if (run.length || edge) body += frag(run.join(' '))
        run = []
      }
      words.forEach((w, i) => {
        if (!c.emotes.includes(w)) {
          run.push(w)
          return
        }
        // the spaces around an emote live in the text runs beside it
        run.push('')
        flush(false)
        body += TW(w)
        run = i < words.length - 1 ? [''] : []
      })
      flush(false)
      const got = read(message(body))
      const bound = new Set(Object.keys(c.want).map(Number))
      const want = words
        .map((w, i) => ({ w, i }))
        .filter(({ w, i }) => c.emotes.includes(w) && !bound.has(i))
        .map(({ w, i }) => {
          const mine = Object.entries(c.want)
            .filter(([, to]) => to === i)
            .flatMap(([k]) => mods.hsModClassify(words[Number(k)]).mods || [])
          const { sx, sy, rotate } = mods.hsModComposeTransform(mine)
          return `${w}:${mods.hsModTransformStr(sx, sy, rotate)}`
        })
      expect(got.emotes).toEqual(want)
      expect(got.text.replace(/\|/g, ' ').split(/\s+/).filter(Boolean)).toEqual(
        words.filter((w, i) => w && !bound.has(i) && !c.emotes.includes(w)),
      )
    })
  }
})
