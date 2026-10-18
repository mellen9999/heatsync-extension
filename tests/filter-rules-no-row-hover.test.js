import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// the filter-rules editor is a form, not one clickable row: a row hover turned
// its hard-coded white help text white-on-white
const css = readFileSync(new URL('../src/multichat/styles/14-interactive-controls.css', import.meta.url), 'utf8')

test('no hover fill on the filter-rules add form or rule rows', () => {
  expect(css).not.toMatch(/\.hs-mc-fr-addform:hover/)
  expect(css).not.toMatch(/\[data-fr-row\]:hover\s*[,{]/)
})
