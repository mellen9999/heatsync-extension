import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/input.js', import.meta.url), 'utf8')

test('findEmoteTarget resolves bare log-surface emote imgs (right-click block / left-click add)', () => {
  const body = src.slice(src.indexOf('function findEmoteTarget'), src.indexOf('function openEmoteCtxMenu'))
  expect(body).toMatch(/hs-cl-emote/)
  expect(body).toMatch(/hs-archive-emote/)
  expect(body).toMatch(/hs-card-log-body/)
})
