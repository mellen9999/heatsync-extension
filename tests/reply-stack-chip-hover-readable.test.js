import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// stack rows are ordinary message rows, so their reply chip takes the white-bg
// hover; the stack forces its chip text white !important, so hover must flip it
const css = readFileSync(new URL('../src/multichat/styles/08-message-rows.css', import.meta.url), 'utf8')

test('a hovered reply chip inside the thread stack is black text on the white hover', () => {
  for (const root of ['#hs-mc-reply-stack', '#hs-mc-reply-stack-down']) {
    const sel = `${root} .hs-mc-reply-stack-row .hs-mc-reply-ctx:hover *`
    const at = css.indexOf(sel)
    expect(at, sel).toBeGreaterThan(-1)
    expect(css.slice(at, at + 420)).toContain('color: #000000 !important')
  }
})
