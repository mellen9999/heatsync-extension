// stand-in for the bundle-scope t(): en message with $NAME$ placeholders filled positionally
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const EN = JSON.parse(readFileSync(join(import.meta.dir, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8'))

export const t = (key, subs = []) => {
  const e = EN[key]
  if (!e) return key
  return e.message.replace(
    /\$([A-Z0-9_]+)\$/g,
    (_, n) => subs[Number.parseInt(e.placeholders[n.toLowerCase()].content.slice(1), 10) - 1] ?? '',
  )
}
