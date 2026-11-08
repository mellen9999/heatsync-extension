// The own-upload rung helpers (src/multichat/emote-rungs.js) as real functions.
//
// emote-rungs.js is concatenated into the multichat bundle (no imports, no
// exports), so a test reads the file and evaluates it — the SHIPPED code runs,
// never a copy. Tests that carve emotes.js hand these in as the globals the
// bundle would have supplied.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emote-rungs.js'), 'utf8')

export const { hsOwnRungUrl, hsEmoteDimAttr, hsOwnCopyFallback, hsOwnCanonicalUrl } = new Function(
  `${SRC}\nreturn { hsOwnRungUrl, hsEmoteDimAttr, hsOwnCopyFallback, hsOwnCanonicalUrl }`,
)()
