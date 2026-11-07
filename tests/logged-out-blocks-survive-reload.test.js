// logged-out blocks live in `local_blocked_emotes`, server blocks in `blocked_emotes`;
// a reload on native chat and on youtube must read BOTH or the block is lost.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p) => readFileSync(join(import.meta.dir, '..', 'chrome', p), 'utf8')

for (const file of ['content.js', 'youtube-content.js']) {
  test(`${file} asks storage for both block lists and unions them`, () => {
    const src = read(file)
    expect(src).toContain("'local_blocked_emotes'")
    expect(src).toMatch(
      /new Set\(\[\s*\.\.\.\(stored\.blocked_emotes \|\| \[\]\),\s*\.\.\.\(stored\.local_blocked_emotes \|\| \[\]\),?\s*\]\)/,
    )
  })
}
