import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const POS = src('chat-position.js')
const RESIZE = src('resize.js')

describe('a resize release relayouts youtube once', () => {
  test('the release applies position as settled, so the load-time player nudges stay off', () => {
    expect(RESIZE).toContain('applyChatPosition({ settled: true })')
    expect(POS).toContain("if (hostPlatform === 'yt' && !settled) {")
  })
  test('position classes are forced toggles, never remove-all then add', () => {
    expect(POS).not.toContain('document.body.classList.add(`hs-chat-${chatPosition}`)')
    expect(POS).toMatch(/classList\.toggle\(`hs-chat-\$\{p\}`, p === chatPosition\)/)
  })
})
