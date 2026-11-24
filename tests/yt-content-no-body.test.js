import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// firefox can run youtube-content.js in a live_chat frame that has no <body> yet. one
// `document.body.appendChild` at the top of the script threw there and stopped it before
// init, so that frame got none of the chat features (e2e s9, 1.7.140 check).
test('youtube-content.js never appends straight to document.body', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'youtube-content.js'), 'utf8')
  expect(src.match(/document\.body\.(appendChild|append|prepend|insertBefore)\(/g) ?? []).toEqual([])
  expect(src.match(/\(document\.body \|\| document\.documentElement\)\.appendChild\(/g)?.length).toBe(2)
})
