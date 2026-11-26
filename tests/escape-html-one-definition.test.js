// escapeHtml is defined once, in src/lib/utils.js; every content bundle carries utils.js (LIB_CORE),
// so a file that needs it calls it. A second copy drifts (the local ones spelled ' as &#39; while
// the lib says &#x27;), and the old three-copy guard in build.js only checked each copy kept up.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml } from '../src/lib/utils.js'

const root = join(import.meta.dir, '..')
const walk = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : [],
  )

test('only src/lib/utils.js defines escapeHtml', () => {
  const def = /(?:^|\n)\s*(?:export\s+)?(?:function\s+escapeHtml\b|(?:const|let|var)\s+escapeHtml\s*=)/
  expect(walk('src').filter((f) => def.test(readFileSync(join(root, f), 'utf8')))).toEqual(['src/lib/utils.js'])
})

test('the shared escapeHtml escapes all five specials and passes null through as empty', () => {
  expect(escapeHtml(`<a href="x" t='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; t=&#x27;y&#x27;&gt;&amp;&lt;/a&gt;')
  expect(escapeHtml(null)).toBe('')
  expect(escapeHtml(undefined)).toBe('')
  expect(escapeHtml(0)).toBe('0')
})
