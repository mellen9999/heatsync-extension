/**
 * Emotes drawn by a logs surface (archive lines, chat-logs panel, a card's
 * recent lines) are bare <img>s — the hover preview has to recognise them or
 * "some emotes can't be hovered".
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const TIPS = readFileSync(join(ROOT, 'src', 'multichat', 'tooltips.js'), 'utf8')

const start = TIPS.indexOf('function isLogEmoteImg(el)')
const end = TIPS.indexOf('\nfunction setupEmoteTooltipHandlers')
const isLogEmoteImg = new Function(`${TIPS.slice(start, end)}\nreturn isLogEmoteImg`)()

const img = (cls, inCardLog = false) => ({
  tagName: 'IMG',
  classList: { contains: (c) => cls.split(' ').includes(c) },
  closest: (sel) => (inCardLog && sel === '.hs-card-log-body' ? {} : null),
})

describe('isLogEmoteImg', () => {
  test('archive and chat-logs emotes qualify', () => {
    expect(isLogEmoteImg(img('hs-archive-emote emote'))).toBe(true)
    expect(isLogEmoteImg(img('hs-cl-emote'))).toBe(true)
  })

  test('a plain .emote counts only inside a card log line', () => {
    expect(isLogEmoteImg(img('emote', true))).toBe(true)
    expect(isLogEmoteImg(img('emote', false))).toBe(false)
  })

  test('other images and non-images do not', () => {
    expect(isLogEmoteImg(img('avatar'))).toBe(false)
    expect(isLogEmoteImg({ tagName: 'SPAN', classList: { contains: () => true }, closest: () => null })).toBe(false)
    expect(isLogEmoteImg(null)).toBe(false)
  })

  test('both the hover and the leave handler use it', () => {
    expect(TIPS.split('isLogEmoteImg(target)').length - 1).toBe(2)
  })
})
