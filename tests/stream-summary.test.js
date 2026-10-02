/**
 * Stream summary — the twitch tab's "stream summary" link renders heatsync's
 * own count of this chat in place (twitch's stream-summary page opened a
 * second window and can't be embedded). stream-stats.js is a concatenated
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
  const cleanup = { setTimeout() {}, setInterval() {}, clearInterval() {} }
  return new Function(
    'document',
    'cleanup',
    'isEnabled',
    'emoteCache',
    'requestIdleCallback',
    `${SRC}; return { bumpStreamStats, buildStreamSummary, streamStats, _flushStatsScanQueue }`,
  )(
    document,
    cleanup,
    () => enabled,
    new Set(['KEKW']),
    () => {},
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
