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

test('a blocked log emote keeps its exact size (pinned before the state flips)', () => {
  const e = readFileSync(new URL('../src/multichat/emotes.js', import.meta.url), 'utf8')
  expect(e).toMatch(/function hsPinLogEmoteSize/)
  expect((e.match(/hsPinLogEmoteSize\(w, true\)/g) || []).length).toBe(2)
  expect((e.match(/hsPinLogEmoteSize\(w, false\)/g) || []).length).toBe(2)
})

test('a card still opens anonymously when the stored heatsync token is rejected (401)', () => {
  const t = readFileSync(new URL('../src/multichat/tooltips.js', import.meta.url), 'utf8')
  const f = t.slice(t.indexOf('async function fetchCardPayload'), t.indexOf('The shared card model + renderer'))
  expect(f).toMatch(/status === 401/)
  expect(f).toMatch(/auth: false/)
})

test('zebra: zebraOfInsert walks past the embed player to the real previous row', () => {
  const main = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
  const fn = main.slice(main.indexOf('function zebraOfInsert'), main.indexOf('// ─── Multistream auto-detect'))
  expect(fn).toMatch(/while \(prevDiv\?\.id === 'hs-mc-embed-player'\) prevDiv = prevDiv\.previousElementSibling/)
})

test('tab-complete: empty cycle still shows searching / no match', () => {
  expect(src).toMatch(/acState\.remotePending \? 'searching 7tv…' : 'no match'/)
})

test('feed >>id hover: bare ids never hover, an on-screen target highlights instead of popping up', () => {
  const social = readFileSync(new URL('../src/multichat/social.js', import.meta.url), 'utf8')
  expect(social).toMatch(/LINK_SEL = '\.hs-post-link, \.hs-feed-thread-link:not\(\.hs-quote-insert\)'/)
  expect(social).toMatch(/_onScreenTarget\(link, linkedId\)[\s\S]{0,200}hs-feed-link-hl/)
})

test('thread id click: the >>id quote always lands at the end of the input', () => {
  const social = readFileSync(new URL('../src/multichat/social.js', import.meta.url), 'utf8')
  const i = social.indexOf('const quote = `>>${qid} `')
  const h = social.slice(i, i + 900)
  expect(h).toMatch(/range\.collapse\(false\)[\s\S]*insertText/)
  expect(h).toMatch(/input\.value \+= quote/)
})
