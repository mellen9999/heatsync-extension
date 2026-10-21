import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// setting rows are labels + controls, not one clickable thing: the controls
// carry the hover, the row never does
const css = readFileSync(new URL('../src/multichat/styles/14-interactive-controls.css', import.meta.url), 'utf8')

test('no hover fill on the filter-rules add form or rule rows', () => {
  expect(css).not.toMatch(/\.hs-mc-fr-addform:hover/)
  expect(css).not.toMatch(/\[data-fr-row\]:hover\s*[,{]/)
})

test('no setting row gets a hover fill — only clickable controls do', () => {
  expect(css).not.toMatch(/\.hs-mc-setting-row(?:\.[\w-]+|:not\([^)]*\))*:hover/)
})
