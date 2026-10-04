// lists en keys missing from each locale: bun scripts/i18n-missing.mjs [--json]
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', 'src', '_locales')
const load = (c) => JSON.parse(readFileSync(join(root, c, 'messages.json'), 'utf8'))
const en = load('en')
const out = {}
for (const c of readdirSync(root).filter((c) => c !== 'en').sort()) {
  const loc = load(c)
  out[c] = Object.keys(en).filter((k) => !(k in loc))
}
if (process.argv.includes('--json')) console.log(JSON.stringify(out))
else for (const [c, m] of Object.entries(out)) console.log(`${c}\t${m.length}`)
