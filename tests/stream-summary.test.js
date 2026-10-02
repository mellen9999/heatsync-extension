/**
 * Stream summary — the channel tab's summary cell renders heatsync's own
 * count of this chat in place (twitch's stream-summary page opened a second
 * window and can't be embedded). stream-stats.js is a concatenated
 * multichat global, so its real source is evaluated against stubs.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'stream-stats.js'), 'utf8')

function el(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    children: [],
    append(...c) {
      this.children.push(...c)
    },
    addEventListener() {},
  }
}
const text = (n) => (n.children.length ? n.children.map(text).join('') : n.textContent)

function load({ enabled = true } = {}) {
  const document = { createElement: el }
  const timers = []
  const cleanup = {
    setTimeout: (fn) => timers.push(fn),
    setInterval() {},
    clearInterval() {},
  }
  return new Function(
    'document',
    'cleanup',
    'isEnabled',
    'emoteCache',
    'requestIdleCallback',
    'hsXButton',
    `${SRC}; return { bumpStreamStats, buildStreamSummary, markStreamEnded, streamStats, _flushStatsScanQueue }`,
  )(
    document,
    cleanup,
    () => enabled,
    new Set(['KEKW']),
    () => {},
    (cls) => Object.assign(el('button'), { className: `hs-x ${cls}`, setAttribute() {} }),
  )
}

describe('stream summary', () => {
  test('counts msgs, unique chatters, mentions, peak/s, top chatters + emotes', () => {
    const m = load()
    m.bumpStreamStats('Chan', { user: 'a', text: 'KEKW hi' }, true)
    m.bumpStreamStats('chan', { user: 'a', text: 'KEKW' }, false)
    m.bumpStreamStats('chan', { user: 'b', text: 'yo' }, false)
    m._flushStatsScanQueue()
    const out = text(m.buildStreamSummary('chan', false))
    expect(out).toContain('chan stream summary')
    expect(out).toContain('3 msgs · 2 chatters · 1 mentions · 3/s peak')
    expect(out).toContain('top chatters a 2 · b 1')
    expect(out).toContain('top emotes KEKW 2')
  })

  test('an ended stream is titled as the recap', () => {
    const m = load()
    m.bumpStreamStats('chan', { user: 'a', text: 'x' }, false)
    expect(text(m.buildStreamSummary('chan', true))).toContain('chan stream ended')
  })

  test('stream:offline stamps the stats, so the cell reads as the recap', () => {
    const m = load()
    expect(m.markStreamEnded('chan')).toBe(false) // no chat, nothing to recap
    m.bumpStreamStats('chan', { user: 'a', text: 'x' }, false)
    expect(text(m.buildStreamSummary('chan', false))).toContain('chan stream summary')
    expect(m.markStreamEnded('chan')).toBe(true)
    expect(text(m.buildStreamSummary('chan', false))).toContain('chan stream ended')
  })

  test('the × exists only when the cell gives it a way back', () => {
    const m = load()
    const has = (n) => /\bhs-x\b/.test(n.className) || n.children.some(has)
    expect(has(m.buildStreamSummary('chan', false))).toBe(false)
    expect(has(m.buildStreamSummary('chan', false, () => {}))).toBe(true)
  })

  test('says why it is empty instead of rendering nothing', () => {
    expect(text(load().buildStreamSummary('chan', false))).toContain('no chat counted yet')
    expect(text(load({ enabled: false }).buildStreamSummary('chan', false))).toContain('stream stats are off')
  })

  test('a trimmed chatter map reports its count as a floor', () => {
    const m = load()
    for (let i = 0; i <= 5000; i++) m.bumpStreamStats('chan', { user: `u${i}` }, false)
    expect(text(m.buildStreamSummary('chan', false))).toContain('5,001+ chatters')
  })
})
