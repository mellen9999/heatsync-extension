// The emote law as one namespace object for the multichat bundle.
// shared/emote-law.ts (+ emote-rank.ts) are TypeScript byte copies of the site's, so one esbuild bundle
// step turns the pair into `var hsEmoteLaw = (() => {...})()`: every helper stays inside it and none
// of its names (offer, browse, buildRoom, ...) can land on a name the shared scope already has.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

export const LAW_GLOBAL = 'hsEmoteLaw'

/**
 * The law's bundled source. A missing copy is a failed build, never an empty string: every chat
 * row calls the law, so a bundle without it throws on the first line drawn.
 */
export function emoteLawSource(root) {
  const entry = join(root, 'shared', 'emote-law.ts')
  if (!existsSync(entry)) {
    throw new Error(`${entry} is missing: run scripts/sync-site-copies.sh (the emote-law.ts copy is what every chat row reads)`)
  }
  // the law, the one ranking helper its callers need beside it (people in Tab are bucketed exactly
  // like emote names), the usage record's arithmetic (emote-usage.ts) and the picker tile's mark
  // (emote-mark.ts), as one namespace
  const out = buildSync({
    stdin: {
      contents:
        "export * from './emote-law.ts'\nexport { matchBucket } from './emote-rank.ts'\nexport * from './emote-usage.ts'\nexport * from './emote-mark.ts'\n",
      resolveDir: join(root, 'shared'),
      loader: 'ts',
    },
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
