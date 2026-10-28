/** The [img] tag on an OP/RE row is hover-only; its peek is held for a flagged post. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rd = (...p) => readFileSync(join(import.meta.dir, '..', ...p), 'utf8')
const view = rd('src/multichat/img-view.js')

describe('img tag peek', () => {
  test('the tag has no click handler of its own', () => {
    expect(view).not.toContain("closest?.('#hs-mc-messages .hs-feed-media-tag[data-src]')")
    expect(view).not.toContain('openImgView(tag.dataset.src)')
  })
  test('a held category shows the box and never builds the picture', () => {
    expect(view).toContain("hsHeldMediaCat((tag.dataset.cats || '').split(' ').filter(Boolean))")
    const held = view.slice(view.indexOf('if (cat) {'), view.indexOf('} else {'))
    expect(held).toContain('hs-img-peek-held')
    expect(held).not.toContain("createElement('img')")
  })
  test('the row stamps the flags on the tag and no underline or pointer', () => {
    const main = rd('src/multichat/main.js')
    expect(main).toContain('data-cats=')
    expect(main).not.toContain('style="text-decoration:underline"${mediaSrc')
    expect(rd('src/multichat/styles/24-img-view.css')).not.toMatch(/hs-feed-media-tag\[data-src\] \{\s*cursor/)
  })
})
