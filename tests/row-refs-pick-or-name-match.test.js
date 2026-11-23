/**
 * A row's refs are two kinds (docs/emote-law.md): what the sender's app shipped as its pick, and a
 * name the server only matched to a word (`nm`). The first reads above the room, the second below
 * it. The row builder marked every ref a name-match, so a picked KEKW lost to the room's KEKW in the
 * extension while the site drew the pick.
 *
 * Source-slice harness (the loop lives inside the row builder): marker drift fails loudly.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml } from '../src/lib/utils.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-tabs.js'), 'utf8')
const START = 'let hsMsgRefs = null'
const END = 'let processedText = processEmotes('
const s = SRC.indexOf(START)
const e = SRC.indexOf(END, s)
if (s === -1 || e === -1) throw new Error('row refs loop markers moved in main-tabs.js')
const refsOf = new Function('m', 'escapeHtml', `${SRC.slice(s, e)}\nreturn hsMsgRefs`)
const run = (hsEmotes) => refsOf({ hsEmotes }, escapeHtml)

const url = 'https://cdn.7tv.app/emote/01AAAAAAAAAAAAAAAAAAAAAAAA/2x.webp'

test('a ref the sender shipped is a pick: not named', () => {
  expect(run({ KEKW: { url, provider: '7tv' } }).get('KEKW').named).toBe(false)
})

test('a ref the server only matched by name is named: it reads below the room', () => {
  expect(run({ KEKW: { url, provider: '7tv', nm: 1 } }).get('KEKW').named).toBe(true)
})

test('a hidden-by-filter stub keeps its mark and its kind', () => {
  const r = run({ Gore: { cw: 'gore', nm: 1 } }).get('Gore')
  expect(r).toMatchObject({ state: 'cw', cw: 'gore', named: true })
})
