// The multichat main body as one string, in bundle order.
//
// main.js was one 16k-line IIFE; it is now main-state.js … main-storage.js
// plus main.js (init + startup), concatenated by build.js (MAIN_PARTS) into one
// scope. A test that slices a function or a region out of "main.js" reads it
// from here, so a function moving between parts never moves a test. The list
// below is pinned to build.js's by main-parts-match-build.test.js.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'multichat')

/** bundle order; main.js closes the list */
export const MAIN_PART_FILES = [
  'main-state.js',
  'main-settings.js',
  'main-overlay.js',
  'main-tabs.js',
  'main-messages.js',
  'main-live.js',
  'main-storage.js',
  'main.js',
]

/** absolute paths of every part, bundle order */
export const MAIN_PART_PATHS = MAIN_PART_FILES.map((f) => join(MC_DIR, f))

let cached = null
/** every part joined in bundle order — the string the old tests read as main.js */
export function mainSource() {
  if (cached == null) cached = MAIN_PART_PATHS.map((p) => readFileSync(p, 'utf8')).join('\n')
  return cached
}
