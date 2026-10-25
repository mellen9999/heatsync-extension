import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../chrome/kick-autocomplete-hook.js', import.meta.url), 'utf8')

// kick's editor learns the selection from `selectionchange`: an edit in the same tick as sel.modify
// lands at the caret ("kappa"+Tab left "kappa" and appended nothing useful)
test('every kick completion edits through replaceBefore, which waits for the editor to take the selection', () => {
  expect(src.match(/sel\.modify\(/g)).toHaveLength(1)
  expect(src).toMatch(
    /await selectionTaken\(\)\s*\n\s*if \(sig\.aborted \|\| sel\.toString\(\) !== word\) return false/,
  )
  expect(src.match(/replaceBefore\(/g)?.length).toBeGreaterThanOrEqual(5)
})
