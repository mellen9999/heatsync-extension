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

test('an account the server says cannot verify is not asked "are you 18?"', () => {
  const at = src.indexOf("hs_age_blocked')).hs_age_blocked")
  expect(at).toBeGreaterThan(0)
  expect(src.slice(at, at + 200)).toContain('if (!blocked)')
  const bg = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
  expect(bg).toContain('hs_age_blocked: data.age_blocked')
  expect(bg).toContain('hs_age_blocked: false')
})
