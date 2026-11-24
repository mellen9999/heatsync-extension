/**
 * Emote modifiers (`w! Kappa`, `Kappa ffzX`) are one rule in every app, kept as data:
 * shared/emote-mods.vectors.json (the site's copy is the source; the desktop app runs it too).
 *
 * `words`: what modifier words add up to, and which words are not modifiers at all
 * (`constructor` after an emote used to read as one and leave the line).
 * `lines`: which emote each modifier word of a line changes, run through the real row
 * renderer (processEmotes), read back from what it drew.
 *
 * A field this runner does not know is a failure, never a skip.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { hsModBind } from '../src/content/native-emote-law.js'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import './emote-rungs-globals.js'

const { hsModClassify, hsModComposeAll, hsModWordsFromState } = mods
// emotes.js is concatenated into the multichat bundle: it calls these as free names
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

const V = JSON.parse(readFileSync(join(import.meta.dir, '..', 'shared', 'emote-mods.vectors.json'), 'utf8'))
const doc = new Window().document

describe('what modifier words add up to', () => {
  const PAINT = ['cursed', 'hyper', 'party']
  test('has enough rows to mean something', () => {
    expect(V.words.length).toBeGreaterThanOrEqual(40)
    expect(V.lines.length).toBeGreaterThanOrEqual(40)
  })
  for (const row of V.words) {
    test(JSON.stringify(row.words), () => {
      const known = ['words', 'plain', 'sx', 'sy', 'turn', 'hue', 'paint']
      expect(Object.keys(row).filter((k) => !known.includes(k))).toEqual([])
      const parts = row.words.split(' ').map((w) => hsModClassify(w, { allowPrefix: false }))
      if (row.plain) {
        expect(parts.map((p) => p.kind)).toEqual(['plain'])
        return
      }
      expect(parts.map((p) => p.kind)).toEqual(parts.map(() => 'modifier'))
      const all = parts.flatMap((p) => p.mods || [])
      const hue = parts.reduce((h, p) => (p.hue != null ? p.hue : h), null)
      const sum = hsModComposeAll(all, hue)
      expect({
        words: row.words,
        sx: sum.sx,
        sy: sum.sy,
        turn: (((sum.rotate / 90) % 4) + 4) % 4,
        hue,
        paint: all.filter((m) => PAINT.includes(m)),
      }).toEqual(row)
    })
  }
})

// the rule on its own (the binder the native page draws by): a line's words, which of them are
// emotes, and each modifier's emote
function bind(line, emotes) {
  const words = line.split(' ')
  return Object.fromEntries(hsModBind(words, (i) => emotes.includes(words[i])))
}

// what the renderer drew: each emote in order with the effects on it (as the row stamps them: one
// spelling per effect, so `ffzW` reads `w!`), and the words left as text
function drawn(html) {
  const root = doc.createElement('div')
  root.innerHTML = html
  const emotes = [...root.querySelectorAll('.hs-mc-emote-wrapper[data-emote-name]')].map((el) => ({
    name: el.dataset.emoteName,
    fx: el.dataset.hsMods || '',
  }))
  for (const el of root.querySelectorAll('.hs-mc-emote-wrapper, .hs-mc-stack-collapse, .hs-mc-stack-block-all'))
    el.remove()
  return { emotes, text: (root.textContent || '').split(/\s+/).filter(Boolean) }
}

describe('which emote a modifier word changes', () => {
  for (const c of V.lines) {
    test(`${c.name}: ${JSON.stringify(c.line)}`, () => {
      expect(Object.keys(c).sort()).toEqual(['emotes', 'line', 'name', 'want'])
      // the rule itself
      expect(bind(c.line, c.emotes)).toEqual(c.want)

      // the row renderer: every emote of the room is a 7tv channel emote, `name0` an overlay
      channelEmoteCaches['chan-x'] = new Map(
        c.emotes.map((name) => [
          name,
          {
            url: `https://cdn.7tv.app/emote/${name.replace(/\W/g, '')}/1x.webp`,
            source: '7tv',
            state: 'channel',
            zeroWidth: name.endsWith('0'),
          },
        ]),
      )
      try {
        const got = drawn(processEmotes(escapeHtml(c.line), 'chan-x', null, null, null))
        const words = c.line.split(' ')
        const bound = new Set(Object.keys(c.want).map(Number))
        // an emote word is drawn unless it is itself a modifier bound to another emote
        const wantEmotes = words
          .map((w, i) => ({ w, i }))
          .filter(({ w, i }) => c.emotes.includes(w) && !bound.has(i))
          .map(({ w, i }) => {
            // the words bound to it, in line order: those before it, then those after it
            const parts = Object.entries(c.want)
              .filter(([, to]) => to === i)
              .map(([k]) => hsModClassify(words[Number(k)], { allowPrefix: false }))
            const hue = parts.reduce((h, p) => (p.hue != null ? p.hue : h), null)
            return {
              name: w,
              fx: hsModWordsFromState(
                parts.flatMap((p) => p.mods || []),
                hue,
              ).join(' '),
            }
          })
        expect(got.emotes).toEqual(wantEmotes)
        expect(got.text).toEqual(words.filter((w, i) => w && !bound.has(i) && !c.emotes.includes(w)))
      } finally {
        delete channelEmoteCaches['chan-x']
      }
    })
  }
})
