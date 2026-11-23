// The emote law as one namespace object for the multichat bundle.
// shared/emote-law.ts (+ emote-rank.ts) are TypeScript byte copies of the site's, so one esbuild bundle
// step turns the pair into `var hsEmoteLaw = (() => {...})()`: every helper stays inside it and none
// of its names (offer, browse, buildRoom, ...) can land on a name the shared scope already has.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

export const LAW_GLOBAL = 'hsEmoteLaw'

/** The law's bundled source, or '' when the copy is not there. */
export function emoteLawSource(root) {
  const entry = join(root, 'shared', 'emote-law.ts')
  if (!existsSync(entry)) return ''
  const out = buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: LAW_GLOBAL,
    target: 'es2020',
    legalComments: 'none',
  })
  return out.outputFiles[0].text
}

/** Does any multichat module name the law? Unused, the bundle would carry ~10KB nothing calls. */
export function lawIsUsed(root) {
  const dir = join(root, 'src', 'multichat')
  return readdirSync(dir).some((f) => f.endsWith('.js') && readFileSync(join(dir, f), 'utf8').includes(LAW_GLOBAL))
}
