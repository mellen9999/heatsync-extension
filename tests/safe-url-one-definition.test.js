// safeUrl is defined once, in src/lib/utils.js (every content bundle carries it via LIB_CORE). The site
// has its own single gate (client/utils/safe-url.js, a separate runtime that cannot import this file);
// this table is the absolute half of the policy the site's tests/unit/safe-url-table.test.ts runs too.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeUrl } from '../src/lib/utils.js'

const root = join(import.meta.dir, '..')
const walk = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : [],
  )

test('only src/lib/utils.js defines safeUrl (or a safeHref/safeImageUrl twin)', () => {
  const def =
    /(?:^|\n)\s*(?:export\s+)?(?:function\s+(?:safeUrl|safeHref|safeImageUrl)\b|(?:const|let|var)\s+(?:safeUrl|safeHref|safeImageUrl)\s*=)/
  expect(walk('src').filter((f) => def.test(readFileSync(join(root, f), 'utf8')))).toEqual(['src/lib/utils.js'])
})

test('the policy table: scripts, data, relative and slash tricks all come back empty', () => {
  const bad = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    '\tjava\nscript:alert(1)',
    '\x01javascript:alert(1)',
    '​javascript:alert(1)',
    'data:text/html,<script>',
    'vbscript:msgbox(1)',
    'blob:https://x/y',
    'file:///etc/passwd',
    'about:blank',
    'mailto:a@b.c',
    'ftp://example.com/f',
    '//evil.com/x',
    '/\\evil.com',
    '/\t/evil.com',
    '\\\\evil.com',
    '/feed',
    '#x',
    'example.com',
    'http://',
    '',
    '   ',
  ]
  for (const u of bad) expect(safeUrl(u), JSON.stringify(u)).toBe('')
  expect(safeUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
  expect(safeUrl('HTTP://EXAMPLE.COM')).toBe('http://example.com/')
  expect(safeUrl(null)).toBe('')
  expect(safeUrl(42)).toBe('')
})
