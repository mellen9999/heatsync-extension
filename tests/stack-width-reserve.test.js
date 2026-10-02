/**
 * Emote-stack inline-advance reservation (src/multichat/emotes.js
 * renderEmoteStack + hsSnapEmoteBox member caching).
 *
 * Regression anchor: chat rows re-wrapped ("jank / rows jumping") when a lazy
 * overlay materialized its width AFTER the row was pinned — worst with an
 * emoji base, where the stack box jumps from glyph width (~17px) to overlay
 * width (~30px+) on decode. renderEmoteStack now stamps min-width = widest
 * CACHED member width so a re-sighted stack reserves its final advance from
 * first paint; hsSnapEmoteBox caches each stack member's own wrapper width
 * (previously stacks were excluded from the width cache entirely).
 *
 * Carved from the content-script source (same rationale as
 * tab-complete-order.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const start = SRC.indexOf('function renderEmoteStack(')
const end = SRC.indexOf('export {')
if (start === -1 || end === -1 || end <= start) throw new Error('renderEmoteStack carve markers not found')

const makeRender = (widths) =>
  new Function('_hsEmoteBoxW', 'hsXButtonHtml', `${SRC.slice(start, end)}; return renderEmoteStack`)(
    new Map(Object.entries(widths)),
    (cls) => `<button class="hs-x ${cls}"></button>`,
  )

const wrap = (url) =>
  `<span class="hs-mc-emote-wrapper" data-emote-name="x" data-emote-url="${url}"><img src="${url}" class="hs-mc-emote hs-emote-channel"></span>`
const emojiBase = '<span class="hs-mc-emoji">🥔</span>'

describe('renderEmoteStack — reserve inline advance from cached member widths', () => {
  test('emoji base + cached overlay → min-width = overlay width', () => {
    const render = makeRender({ 'https://cdn.7tv.app/e/a/1x.avif': 30 })
    const html = render({ base: emojiBase, overlays: [wrap('https://cdn.7tv.app/e/a/1x.avif')] })
    expect(html).toContain('style="min-width:30px"')
  })

  test('two cached members → min-width = widest', () => {
    const render = makeRender({ u1: 28, u2: 44 })
    const html = render({ base: wrap('u1'), overlays: [wrap('u2')] })
    expect(html).toContain('style="min-width:44px"')
  })

  test('nothing cached → no reservation stamped', () => {
    const render = makeRender({})
    const html = render({ base: emojiBase, overlays: [wrap('u-unknown')] })
    expect(html).not.toContain('min-width')
    expect(html).toContain('hs-mc-emote-stack')
  })

  test('no overlays → base returned unwrapped (unchanged behavior)', () => {
    const render = makeRender({ u1: 28 })
    expect(render({ base: wrap('u1'), overlays: [] })).toBe(wrap('u1'))
  })

  test('escaped ampersand in attr resolves against raw-url cache key', () => {
    const render = makeRender({ 'https://c.dn/e?a=1&b=2': 33 })
    const html = render({ base: emojiBase, overlays: [wrap('https://c.dn/e?a=1&amp;b=2')] })
    expect(html).toContain('style="min-width:33px"')
  })

  test('overlay img gets the overlay class + stale width stripped (existing contract)', () => {
    const render = makeRender({})
    const overlay = wrap('u2').replace('data-emote-url="u2"', 'data-emote-url="u2" style="width:28px"')
    const html = render({ base: wrap('u1'), overlays: [overlay] })
    expect(html).toContain('hs-mc-overlay-emote')
    expect(html).not.toContain('style="width:28px"')
  })
})
