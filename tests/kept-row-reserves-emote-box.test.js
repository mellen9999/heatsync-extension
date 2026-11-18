/**
 * A row's text html is kept from its first render. If an emote in it had never loaded then,
 * that html has no width for it, and the row drawn from it later was laid out narrow and
 * re-wrapped when the picture landed: after a closed card the reader's row slid down by a
 * line for every such row above it (real twitch, e2e s20, 11-17: 184px).
 *
 * Runs the real hsReserveEmoteBoxes over a row model.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const a = SRC.indexOf('function hsReserveEmoteBoxes(')
const reserve = (widths) =>
  new Function('_hsEmoteBoxW', `${SRC.slice(a, SRC.indexOf('\n}\n', a) + 3)}\nreturn hsReserveEmoteBoxes`)(widths)

const wrapper = ({ url, width = '', cls = [], modSx, inStack = false }) => ({
  style: { width },
  dataset: { emoteUrl: url, ...(modSx ? { hsModSx: modSx } : {}) },
  classList: { contains: (c) => cls.includes(c) },
  closest: (sel) => (sel === '.hs-mc-emote-stack' && inStack ? {} : null),
})
const row = (...ws) => ({ querySelectorAll: (sel) => (sel === '.hs-mc-emote-wrapper[data-emote-url]' ? ws : []) })

describe('a row drawn from kept html', () => {
  test('an emote that has loaded since gets its box before the picture does', () => {
    const w = wrapper({ url: 'https://cdn.example/a.webp' })
    reserve(new Map([['https://cdn.example/a.webp', 37]]))(row(w))
    expect(w.style.width).toBe('37px')
  })

  test('an emote never seen loaded is left to size itself', () => {
    const w = wrapper({ url: 'https://cdn.example/new.webp' })
    reserve(new Map([['https://cdn.example/a.webp', 37]]))(row(w))
    expect(w.style.width).toBe('')
  })

  test('a box the html already carries is not touched', () => {
    const w = wrapper({ url: 'https://cdn.example/a.webp', width: '40px' })
    reserve(new Map([['https://cdn.example/a.webp', 37]]))(row(w))
    expect(w.style.width).toBe('40px')
  })

  test('a stack member, a modified emote, a kick crop and a content-warning cover keep their own sizing', () => {
    const widths = new Map([['u', 37]])
    for (const w of [
      wrapper({ url: 'u', inStack: true }),
      wrapper({ url: 'u', modSx: '2' }),
      wrapper({ url: 'u', cls: ['hs-kick-crop'] }),
      wrapper({ url: 'u', cls: ['hs-mc-emote-cw'] }),
    ]) {
      reserve(widths)(row(w))
      expect(w.style.width).toBe('')
    }
  })

  test('nothing learned yet: the row is not walked at all', () => {
    let walked = false
    reserve(new Map())({
      querySelectorAll: () => {
        walked = true
        return []
      },
    })
    expect(walked).toBe(false)
  })

  test('the row builder does this for kept html only, and only when the text holds an emote', () => {
    const main = mainSource()
    expect(main).toMatch(
      /const keptHtml = m\._renderedHtml != null[^\n]*\n\s*const processedText = m\.text \? computeMessageText\(m\) : ''/,
    )
    expect(main).toMatch(
      /div\.innerHTML = `\$\{replyBar\}\$\{msgBody\}`\n\s*if \(keptHtml && processedText\.includes\('hs-mc-emote-wrapper'\)\) hsReserveEmoteBoxes\(div\)/,
    )
  })
})
