import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// an under-18 account (or one with no birth year) is refused by the server's
// age-verify; the toggle must roll back and show the server's reason, not the
// generic "try again" save-failed toast
const src = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')

test('age-verify refusal rolls back declined and surfaces the server reason', () => {
  const at = src.indexOf("av?.code === 'AGE_REQUIRED'")
  expect(at).toBeGreaterThan(0)
  const block = src.slice(at, at + 220)
  expect(block).toContain('_cwRollback(def, v, true)')
  expect(block).toContain("showToast(av.error, 'error')")
})
