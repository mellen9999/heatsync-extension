import { expect, test } from 'bun:test'
import { SETTINGS } from '../src/lib/settings-schema.js'

// The display page's `default` button resets every row in the category that
// is not noReset. hiddenPaintUsers lives in display/cosmetics but is a list of
// people this viewer chose to hide, not a preference — and it syncs to
// heatsync.org, so a reset there wiped it on every surface at once.
test('display reset leaves the hidden-paint list alone', () => {
  const def = SETTINGS.find((d) => d.key === 'hiddenPaintUsers')
  expect(def.category).toBe('display')
  expect(def.noReset).toBe(true)
})
