/**
 * kick-css-fix.js rewrites kick's `x:is(:where(.group\/g):has(..) *)` utilities
 * into plain descendants. The shape makes chrome re-style the whole page on every
 * DOM insertion; the rewrite must keep what each rule matches.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

new Function(readFileSync(new URL('../chrome/kick-css-fix.js', import.meta.url), 'utf8'))()
const { rewrite, plan } = globalThis.__hsKickCssFix

describe('kick css rewrite', () => {
  test('a group-has utility becomes a plain descendant of the group', () => {
    const css =
      '.group-has-\\[\\:focus-visible\\]\\/card\\:hidden:is(:where(.group\\/card):has(:focus-visible) *){display:none}'
    expect(rewrite(css)).toBe(
      ':where(.group\\/card):has(:focus-visible) .group-has-\\[\\:focus-visible\\]\\/card\\:hidden{display:none}',
    )
  })

  test('inside @layer and @media, with a selector after it, and in a list', () => {
    const css =
      '@layer utilities{@media (min-width:64rem){.a\\:b:is(:where(.group\\/x):has([data-k]) *) :is(a,button){top:1px}}}' +
      '.c:is(:where(.group\\/y):has(:focus) *),.d{left:0}'
    expect(rewrite(css)).toBe(
      '@layer utilities{@media (min-width:64rem){:where(.group\\/x):has([data-k]) .a\\:b :is(a,button){top:1px}}}' +
        ':where(.group\\/y):has(:focus) .c,.d{left:0}',
    )
  })

  test('escaped parens in the class name do not end the match early', () => {
    const css = '.p\\:\\[\\&_\\:is\\(a\\,b\\)\\]\\:q:is(:where(.group\\/card):has([data-card-link]) *) :is(a,b){x:y}'
    expect(rewrite(css)).toBe(
      ':where(.group\\/card):has([data-card-link]) .p\\:\\[\\&_\\:is\\(a\\,b\\)\\]\\:q :is(a,b){x:y}',
    )
  })

  test('rules the shape does not fit are left alone', () => {
    const plain = [
      '.x:is(:where(.group\\/main)[data-chat=false] *){a:b}', // no :has, already cheap
      '.a .b:is(:where(.group\\/x):has(:focus) *){a:b}', // prefix is not the first compound
      '.x:not(.y):is(:where(.group\\/x):has(:focus) *){a:b}', // paren inside the prefix
      '.x:is(:where(.group\\/x):has(:focus) .z){a:b}', // already a descendant form
    ]
    for (const css of plain) expect(rewrite(css)).toBe(css)
  })

  test('is idempotent and returns the same string when nothing matches', () => {
    const css = '.x:is(:where(.group\\/g):has(:hover) *){a:b}.y{c:d}'
    const once = rewrite(css)
    expect(rewrite(once)).toBe(once)
    expect(rewrite('.y{c:d}')).toBe('.y{c:d}')
  })
})

describe('kick css plan', () => {
  const plain = '@layer utilities{.a{x:y}}'
  const light = '@layer utilities{.g1:is(:where(.group\\/c):has(:focus) *){x:y}}'
  const heavy = '@layer utilities{.g2:is(:where(.group\\/c):has([data-l]) *) :is(a,button){pointer-events:auto}}'

  test('the rule that keeps a tag subject is cut out; the rest keeps its order', () => {
    const runs = plan(`@layer edge,components;${plain}${light}${heavy}${plain}`)
    expect(runs.map((r) => r.heavy)).toEqual([false, true, false])
    expect(runs[1].css).toBe(
      '@layer utilities{:where(.group\\/c):has([data-l]) .g2 :is(a,button){pointer-events:auto}}',
    )
    expect(runs.map((r) => r.css).join('')).toBe(rewrite(`@layer edge,components;${plain}${light}${heavy}${plain}`))
  })

  test('a sheet with nothing to rewrite comes back as one light run, byte for byte', () => {
    const css = `@layer edge,components;${plain}@media (min-width:1px){.b{c:d}}.e{f:g}`
    expect(plan(css)).toEqual([{ css, heavy: false }])
  })

  test('braces and parens inside strings and escapes do not split a rule', () => {
    const css = '.a[title="}{"]{x:y}.b\\{c{d:e}'
    expect(
      plan(css)
        .map((r) => r.css)
        .join(''),
    ).toBe(css)
  })
})

describe('kick css plan, one big layer', () => {
  const g = '.g:is(:where(.group\\/c):has([data-l]) *) :is(a,button){pointer-events:auto}'
  const css = `@layer edge,components;@layer utilities{.a{x:y}${g}@media (min-width:1px){.b{c:d}}.e{f:g}}`
  const runs = plan(css)

  test('only the costly rule leaves the layer; its neighbours stay in layers of the same name, in order', () => {
    expect(runs).toEqual([
      { css: '@layer edge,components;@layer utilities{.a{x:y}}', heavy: false },
      { css: '@layer utilities{:where(.group\\/c):has([data-l]) .g :is(a,button){pointer-events:auto}}', heavy: true },
      { css: '@layer utilities{@media (min-width:1px){.b{c:d}}}@layer utilities{.e{f:g}}', heavy: false },
    ])
  })
})
