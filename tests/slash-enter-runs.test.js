import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "/lclear" typed out and Enter: the open command list took the Enter to fill in
 * the same command and closed, so nothing ran until a second Enter (s18 caught it
 * live). A command typed in full that needs no argument now runs on the first.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const s = SRC.indexOf('function slashRunsAsTyped(')
const runs = new Function(`${SRC.slice(s, SRC.indexOf('\nfunction insertSlashCommand', s))}\nreturn slashRunsAsTyped`)()

const lclear = { cmd: 'lclear', args: '', alias: ['lc'] }
const status = { cmd: 'status', args: '[channel]' }
const hide = { cmd: 'hide', args: '<user>' }

test('the whole command, or its alias, needing nothing: runs', () => {
  expect(runs(lclear, '/lclear')).toBe(true)
  expect(runs(lclear, ' /LClear ')).toBe(true)
  expect(runs(lclear, '/lc')).toBe(true)
  expect(runs(status, '/status')).toBe(true)
})

test('a prefix, or a command that needs its argument: still filled in first', () => {
  expect(runs(lclear, '/lcl')).toBe(false)
  expect(runs(hide, '/hide')).toBe(false)
})

test('the dropdown hands such an Enter on instead of eating it', () => {
  const branch = SRC.slice(
    SRC.indexOf('if (slashAcState.active) {'),
    SRC.indexOf("if (e.key === 'Escape')", SRC.indexOf('if (slashAcState.active) {')),
  )
  expect(branch).toMatch(
    /e\.key === 'Enter' && sel && slashRunsAsTyped\(sel, getInputText\(\)\)\) \{\n\s+hideSlashDropdown\(\)\n\s+\} else \{\n\s+e\.preventDefault\(\)/,
  )
})
