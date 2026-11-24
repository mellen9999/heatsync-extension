/**
 * A picker tile says who will see the emote if you send it (the emote law's offer: "says who will
 * see it"). The Tab readout always did; a tile's hover text only named its provider, so a picture
 * found in the picker's search (heatsync only) read the same as the channel's own (7tv users).
 * The tile asks the readout's own classifier, so the two can never disagree.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './t-stub.js'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const slice = (src, from, to) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error(`carve markers not found: ${from} .. ${to}`)
  return src.slice(a, b)
}
const TILE = slice(
  read('emotes.js'),
  'function emoteImgHtml([name, emote])',
  '/**\n * Emote picker — DOM is built once',
)
const META = slice(read('input.js'), 'function emoteCycleMeta(m)', 'function showCycleTooltip()')

const emoteImgHtml = new Function(
  't',
  'escapeHtml',
  'hsEmoteHiddenForViewer',
  'emoteIsBlocked',
  'hsRungUrl',
  `${META}\n${TILE}\nreturn emoteImgHtml`,
)(
  t,
  (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
  () => null,
  () => false,
  (u) => u,
)
const title = (name, emote) => /title="([^"]*)"/.exec(emoteImgHtml([name, { url: 'https://x/e.webp', ...emote }]))[1]

describe('a picker tile says who sees it', () => {
  test("the channel's or a global third-party emote: that provider's users", () => {
    expect(title('KEKW', { source: '7tv', state: 'global' })).toBe('KEKW (7tv · 7tv users)')
    expect(title('Pog', { source: 'ffz' })).toBe('Pog (ffz · ffz users)')
  })
  test("a platform's own emote: everyone there", () => {
    expect(title('Kappa', { source: 'twitch' })).toBe('Kappa (twitch · all twitch)')
    expect(title('kickW', { source: 'kick' })).toBe('kickW (kick · all kick)')
  })
  test('your own copy, whatever provider it came from: heatsync only', () => {
    expect(title('KEKW', { source: '7tv', state: 'owned' })).toBe('KEKW (7tv · heatsync only)')
    expect(title('Mine', { source: 'heatsync' })).toBe('Mine (heatsync · heatsync only)')
  })
  test('a search answer or an away favorite (a variant tile) is not loaded here: heatsync only', () => {
    expect(title('KEKW', { source: '7tv', variant: '7tv:01X' })).toBe('KEKW (7tv · heatsync only)')
  })
})
