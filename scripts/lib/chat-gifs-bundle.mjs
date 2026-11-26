// A twitch gif-keyboard line's rules as one namespace object for the multichat bundle.
// src/lib/chat-gifs.js (the frame parser, the held-event ledger, the caption rule) and shared/gif-links.ts (the
// validator: https, a giphy/tenor media host, a picture file, a few at most) are byte copies of the site's, the
// first importing the second by the same relative path it has on the site, so one esbuild step makes
// `var hsChatGifs = (() => {...})()`: none of their names can land on a name the shared scope already has,
// and the row, the frame and the site read ONE validator. The module's exports become the returned object
// by hand: esbuild's own iife global would add ~600 bytes of module interop that nothing here uses.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

export const GIFS_GLOBAL = 'hsChatGifs'

/**
 * The bundled source. A missing copy is a failed build, never an empty string: every row with media calls it,
 * so a bundle without it throws on the first line drawn.
 */
export function chatGifsSource(root) {
  for (const rel of ['src/lib/chat-gifs.js', 'shared/gif-links.ts']) {
    if (!existsSync(join(root, rel))) {
      throw new Error(`${join(root, rel)} is missing: run scripts/sync-site-copies.sh (every row with a picture reads ${GIFS_GLOBAL})`)
    }
  }
  const out = buildSync({
    stdin: {
      contents: "export * from './chat-gifs.js'\nexport { chatGifs } from '../../shared/gif-links.ts'\n",
      resolveDir: join(root, 'src', 'lib'),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2020',
    legalComments: 'none',
  })
  const code = out.outputFiles[0].text
  const exported = code.match(/^export\s*\{([^}]*)\};?\s*$/m)
  if (!exported) throw new Error(`${GIFS_GLOBAL}: the bundle has no export list to return`)
  const api = exported[1]
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => {
      const [local, name = local] = n.split(/\s+as\s+/)
      return name === local ? name : `${name}: ${local}`
    })
  return `var ${GIFS_GLOBAL} = (() => {\n${code.replace(exported[0], '')}\nreturn { ${api.join(', ')} }\n})()\n`
}
