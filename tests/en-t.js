import { readFileSync } from 'node:fs'

const EN = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))

/**
 * Stand-in for the bundle-scope t() that sliced-source tests inject: the en message with its
 * $NAME$ placeholders filled from the positional substitutions. A missing key comes back as the key.
 */
export function t(key, subs = []) {
  const e = EN[key]
  if (!e) return key
  return e.message.replace(
    /\$([A-Z0-9_]+)\$/g,
    (_, n) => subs[Number.parseInt(e.placeholders[n.toLowerCase()].content.slice(1), 10) - 1] ?? '',
  )
}
