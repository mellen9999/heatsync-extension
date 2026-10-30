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

test("blocked card-line emote: the pinned size out-ranks the card's width:auto !important", () => {
  const css = readFileSync(new URL('../src/multichat/styles/18-chat-log.css', import.meta.url), 'utf8')
  expect(css).toMatch(/img\.hs-state-blocked:is\(\.emote[^{]*\{\s*width: var\(--hs-lock-w, 24px\) !important/)
})

test('whispers and inline dms resolve channel emotes via the all-channels map', () => {
  for (const f of ['whispers.js', 'main.js']) {
    const t = readFileSync(new URL(`../src/multichat/${f}`, import.meta.url), 'utf8')
    expect(t).toMatch(/processEmotes\(escapeHtml\(m\.text\), null, hsAnyChannelEmotes\(\)/)
  }
})

test('kick no-channel pages lift the top bar out of the squeezed body', () => {
  const css = readFileSync(new URL('../src/multichat/styles/17-platform-position.css', import.meta.url), 'utf8')
  expect(css).toMatch(
    /hs-kick-no-channel\.hs-chat-right nav\[class\*="navbar-height"\][\s\S]{0,400}position: fixed !important/,
  )
  expect(css).toMatch(/\[class\*="group\/main"\][\s\S]{0,120}padding-top: var\(--hs-kick-topnav-h, 60px\)/)
})

test('event row click opens the channel on its live tab, not the last active tab', () => {
  const src = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
  expect(src).toMatch(/window\.open\(streamEventUrl\(evtPlat, ch\)/)
  expect(src).toMatch(/location\.hash === '#hs-live'\) \{\s*_savedActiveTab = 'live'/)
  expect(src).toMatch(
    /config\.channels\.push\(hsLiveChannelEntry\(plat, cur\)\)[\s\S]*?saveConfig\(\)[\s\S]*?_savedActiveTab = cur/,
  )
})

test('live tabs reserve room for the live dot so the unread count never sits under it', () => {
  const css = readFileSync(new URL('../src/multichat/styles/02-tab-bar.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.hs-mc-tab\[data-live="true"\] \{\s*padding-right: 16px !important/)
})

test('a row inserted mid-list restripes everything after it', () => {
  const src = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
  expect(src).toMatch(/function zebraRepaint\(msgsEl, from\)/)
  expect(src).toMatch(/if \(after\) zebraFrom = zebraFrom || div/)
  expect(src).toMatch(/if \(zebraFrom\) zebraRepaint\(msgsEl, zebraFrom\)/)
})

test('tabs re-assert channel interest so a restarted service worker cannot strand an older tab', () => {
  const irc = readFileSync(new URL('../src/multichat/irc.js', import.meta.url), 'utf8')
  const bg = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
  expect(irc).toMatch(/type: 'bg_irc_interest', channels: \[\.\.\.this\.channels\.keys\(\)\]/)
  expect(irc).toMatch(/_interestTimer = cleanup\.setInterval\(\(\) => this\._reassertInterest\(\), 15000\)/)
  expect(bg).toMatch(/message\.type === 'bg_irc_interest'[\s\S]*?bgIrcRegisterTabInterest\(tabId, ch\)/)
})

test('kick wide emotes crop to their art instead of drawing as a strip in a square', () => {
  const src = readFileSync(new URL('../src/multichat/emotes.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/multichat/styles/10-emotes.css', import.meta.url), 'utf8')
  expect(src).toMatch(/KICK_CROP_MIN_ASPECT = 1\.5/)
  expect(src).toMatch(/_kickCropRequest\(emoteId\)/)
  expect(src).toMatch(/data-kick-id="\$\{emoteId\}"/)
  expect(css).toMatch(/\.hs-mc-emote-wrapper\.hs-kick-crop > img\.hs-mc-emote/)
})
