/**
 * An event row that carries a line its sender typed (a shared watch streak, a resub message) is
 * two lines: the event, then "name: line" as in chat. A filled notice was made "its own label",
 * the event text inline in the row, and with a typed line after it the row read as one long run:
 * "Rilout watched 255 consecutive streams and sparked a watch streak![T]Rilout: soviHii".
 * The real layout is measured in scripts/render-notice-lines.ts; the decision runs here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const MSGS = readFileSync(new URL('../src/multichat/main-messages.js', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../src/multichat/styles/08-message-rows.css', import.meta.url), 'utf8')

const line = MSGS.match(/const saidUnder = ([^\n]+)\n/)?.[1]
const saidUnder = (filledRow, m) => new Function('filledRow', 'm', `return ${line}`)(filledRow, m)

describe('an event with a typed line', () => {
  test('is two lines when the row is filled and carries both the event and the line', () => {
    expect(saidUnder(true, { type: 'usernotice', systemMsg: 'x watched 255 streams', text: 'soviHii' })).toBe(true)
    expect(saidUnder(true, { type: 'usernotice', systemMsg: 'x resubscribed', text: 'hype' })).toBe(true)
  })

  test('an event with nothing typed stays one label line', () => {
    expect(saidUnder(true, { type: 'usernotice', systemMsg: 'x subscribed', text: '' })).toBe(false)
    expect(saidUnder(true, { type: 'usernotice', systemMsg: 'x subscribed' })).toBe(false)
  })

  test('a plain notice, a row with no event text and an unfilled row are left as they were', () => {
    expect(saidUnder(true, { type: 'notice', systemMsg: 'x', text: 'slow mode on' })).toBe(false)
    expect(saidUnder(true, { type: 'usernotice', text: 'an announcement' })).toBe(false)
    expect(saidUnder(false, { type: 'usernotice', systemMsg: 'x', text: 'y' })).toBe(false)
  })

  test('the row is its own label only when nothing sits under the event', () => {
    expect(MSGS).toMatch(
      /if \(filledRow && !saidUnder && div\.classList\.contains\('hs-mc-system'\)\) div\.classList\.add\('hs-row-label'\)/,
    )
    // the event text is then the label, on a line of its own
    expect(MSGS).toMatch(/class="hs-mc-system-text\$\{saidUnder \? ' hs-row-label' : ''\}"/)
  })

  test('the inline run is for whole-label rows only: an event text with a line under it is a block', () => {
    expect(CSS).toMatch(/\.hs-mc-system\.hs-filled\.hs-row-label \.hs-mc-system-text \{ display: inline;/)
    expect(CSS).not.toMatch(/\.hs-mc-system\.hs-filled \.hs-mc-system-text \{ display: inline;/)
    expect(CSS).toMatch(/\.hs-mc-system-text \{\s*color: #ffffff;\s*font-size: 13px;\s*display: block;/)
  })
})
