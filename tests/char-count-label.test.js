import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const rd = (f) => readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
const { charCountLabel } = new Function(`${rd('send-targets.js')}\nreturn { charCountLabel }`)()

describe('n/limit counter', () => {
  test('silent until within 10% of the cap', () => {
    expect(charCountLabel(0, 500)).toBeNull()
    expect(charCountLabel(450, 500)).toBeNull()
  })
  test('warns just past 90%, goes over past the cap', () => {
    expect(charCountLabel(451, 500)).toEqual({ text: '451/500', level: 'warn' })
    expect(charCountLabel(500, 500)).toEqual({ text: '500/500', level: 'warn' })
    expect(charCountLabel(501, 500)).toEqual({ text: '501/500', level: 'over' })
  })
  test('a bad limit shows nothing', () => {
    expect(charCountLabel(5, 0)).toBeNull()
    expect(charCountLabel(5, Number.NaN)).toBeNull()
  })
  test('wired: updateCharCount paints it and the css uses palette colours', () => {
    expect(rd('input.js')).toContain('charCountLabel(text.trim().length, limit)')
    const css = rd('styles/11-input-composer.css')
    expect(css).toContain('#hs-mc-charcount')
  })
})
