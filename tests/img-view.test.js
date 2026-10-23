import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rd = (...p) => readFileSync(join(import.meta.dir, '..', ...p), 'utf8')

describe('img view takeover', () => {
  test('is built, closable by ← back, and opened by a feed picture click', () => {
    expect(rd('build.js')).toContain("'img-view.js'")
    expect(rd('src/multichat/pane-panel.js')).toContain('closeImgView')
    const v = rd('src/multichat/img-view.js')
    expect(v).toContain('hs-feed-media-img')
    expect(v).toContain('hsTakeoverSync()')
  })
})
