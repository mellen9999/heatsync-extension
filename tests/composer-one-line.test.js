/**
 * A pasted multi-line pasta (or shift+enter) lands in the composer as
 * <div>/<br>. Serialized, each line must start a new word and the whole send
 * must be one line: twitch posts only the first line of a multi-line PRIVMSG.
 * Shapes below are what chromium's insertText/insertLineBreak/insertParagraph
 * actually produce. getInputText is carved from the real source.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const ROOT = join(import.meta.dir, '..')
const IRC = readFileSync(join(ROOT, 'src', 'multichat', 'irc.js'), 'utf8')
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`"${name}" not found`)
  return src.slice(start, src.indexOf('\n}', start) + 2)
}
const blockTags = INPUT.match(/const BLOCK_TAGS = .*\n/)?.[0]
if (!blockTags) throw new Error('BLOCK_TAGS not found')

const win = new Window()
const doc = win.document
const getInputText = new Function(
  'document',
  'Node',
  'wysiwygEnabled',
  `${blockTags}${fn(IRC, 'oneLine')}
${fn(INPUT, 'getInputText')}
return getInputText`,
)(doc, win.Node, true)

function composer(html) {
  doc.body.innerHTML = `<div id="hs-mc-input" contenteditable="true">${html}</div>`
  return getInputText()
}

describe('composer serializes to one line', () => {
  test('pasted lines (div per line) keep their word breaks', () => {
    expect(composer('line one<div>line two</div><div>line three</div>')).toBe('line one line two line three')
  })
  test('shift+enter <br> is a space', () => {
    expect(composer('aa<br>bb')).toBe('aa bb')
  })
  test('insertParagraph div is a space', () => {
    expect(composer('aa<div>bb</div>')).toBe('aa bb')
  })
  test('raw newlines in a text node flatten with their padding', () => {
    expect(composer('aa \n\n  bb\r\ncc')).toBe('aa bb cc')
  })
  test('an emote chip inside a pasted line still serializes', () => {
    expect(composer('hi<div>look <img data-emote-name="KEKW" alt="KEKW"> lol</div>')).toBe('hi look KEKW lol')
  })
  test('a trailing empty line adds nothing', () => {
    expect(composer('gm<div><br></div>').trim()).toBe('gm')
  })
  test('single-line text is untouched', () => {
    expect(composer('gm  chat')).toBe('gm  chat')
  })
})
