import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/input.js', import.meta.url), 'utf8')

test('findEmoteTarget resolves bare log-surface emote imgs (right-click block / left-click add)', () => {
  const body = src.slice(src.indexOf('function findEmoteTarget'), src.indexOf('function openEmoteCtxMenu'))
  expect(body).toMatch(/hs-cl-emote/)
  expect(body).toMatch(/hs-archive-emote/)
  expect(body).toMatch(/hs-card-log-body/)
})

test('a lone zero-width log emote stays interactive (zw only on a real overlay)', () => {
  const cl = readFileSync(new URL('../src/multichat/chat-logs.js', import.meta.url), 'utf8')
  expect(cl).toMatch(/prev\?\.tagName === 'IMG'/)
})

test('same-name log emotes join the cross-highlight / block / flash set', () => {
  const m = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
  const q = m.slice(m.indexOf('function queryEmoteWrappers'), m.indexOf('function trimChildren'))
  expect(q).toMatch(/hs-card-log-body img\[alt=/)
  expect(q).toMatch(/hs-cl-emote\[alt=/)
})
