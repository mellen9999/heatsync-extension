/** Clickable bits of an OP/RE chat row invert on hover: white bg, black text. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'styles', '02-tab-bar.css'), 'utf8')

describe('inline feed row hover', () => {
  for (const sel of ['.hs-feed-thread-link', '.hs-hashtag', '.hs-mc-link', '.hs-mc-user']) {
    test(`${sel} hovers white-on-black`, () => {
      const re = new RegExp(`\\.hs-mc-feed-inline ${sel.replace(/[.[\]]/g, '\\$&')}:hover[^{]*\\{([^}]*)\\}`)
      const body = css.match(re)?.[1] ?? ''
      expect(body).toContain('background: #fff')
      expect(body).toContain('color: #000')
    })
  }
  test('the row itself is not clickable, so it keeps the default cursor', () => {
    expect(css).not.toContain('.hs-mc-feed-inline:not(.hs-mc-dm-inline) { cursor: pointer; }')
  })
})
