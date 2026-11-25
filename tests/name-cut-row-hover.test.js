import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A switched-to / went-live row inverts on hover; its name sits on a black cutout. The
// row's descendant rule made the name black on black (2026-11-25). The name rule must
// out-rank that descendant rule, both being !important.
const css = readFileSync(join(import.meta.dir, '../src/multichat/styles/17-platform-position.css'), 'utf8')

/** [ids, classes/attrs/pseudo-classes, types] — :where() counts 0, :not() counts its argument */
function specificity(sel) {
  let s = sel
  while (/:where\(/.test(s)) s = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/, '')
  s = s.replace(/:not\(((?:[^()]|\([^()]*\))*)\)/g, ' $1')
  const ids = (s.match(/#[\w-]+/g) || []).length
  const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length
  return [ids, cls]
}
const beats = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])

function ruleFor(needle) {
  const i = css.indexOf(needle)
  expect(i, needle).toBeGreaterThan(-1)
  const open = css.indexOf('{', i)
  const start = css.lastIndexOf('}', i) + 1
  return {
    sels: css
      .slice(start, open)
      .split(/,\n/)
      .map((x) => x.trim())
      .filter(Boolean),
    body: css.slice(open, css.indexOf('}', open)),
  }
}

test('a hovered filled row keeps its name white on the black cutout', () => {
  const name = ruleFor(':hover .hs-name-cut :where(a, .hs-mc-user):not(:hover),')
  expect(name.body).toContain('color: #fff !important')
  expect(name.body).toContain('-webkit-text-fill-color: #fff !important')
  const row = ruleFor(':not([data-hs-name-hover]):hover *,')
  expect(row.body).toContain('color: #000 !important')
  const rowSel = row.sels.find((x) => x.endsWith(':hover *'))
  for (const sel of name.sels.filter((x) => x.includes(':hover'))) {
    expect({ sel, wins: beats(specificity(sel), specificity(rowSel)) }).toEqual({ sel, wins: true })
  }
})

test('the name itself still inverts alone: the white rule stands down under the pointer', () => {
  const name = ruleFor(':hover .hs-name-cut :where(a, .hs-mc-user):not(:hover),')
  for (const sel of name.sels.filter((x) => x.includes(':hover')))
    expect(sel).toContain(':where(a, .hs-mc-user):not(:hover)')
})
