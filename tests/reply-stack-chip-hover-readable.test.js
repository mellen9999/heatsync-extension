import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// stack rows are ordinary message rows, so their reply chip takes the white-bg
// hover; the stack forces its chip text white !important, so hover must flip it
const css = readFileSync(new URL('../src/multichat/styles/08-message-rows.css', import.meta.url), 'utf8')

test('a hovered reply chip on the opened row is black text on the white hover', () => {
  const at = css.indexOf('.hs-mc-msg.hs-mc-reply-stack-active .hs-mc-reply-ctx:hover *')
  expect(at).toBeGreaterThan(-1)
  expect(css.slice(at, at + 700)).toContain('-webkit-text-fill-color: #000000 !important')
})

test('a hovered reply chip inside the thread stack is black text on the white hover', () => {
  for (const root of ['#hs-mc-reply-stack', '#hs-mc-reply-stack-down']) {
    const sel = `${root} .hs-mc-reply-stack-row .hs-mc-reply-ctx:hover *`
    const at = css.indexOf(sel)
    expect(at, sel).toBeGreaterThan(-1)
    expect(css.slice(at, at + 420)).toContain('color: #000000 !important')
  }
})
