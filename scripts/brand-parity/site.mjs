// node site.mjs <out.json> — the SITE renderer (real live-chat.js + real css via vite dev on :5199)
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { collect } from './collect.mjs'
const { chromium } = createRequire(import.meta.url)(process.env.HS_PW || 'playwright-core')
const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1920, height: 1080 } })
await p.goto('http://127.0.0.1:5199/robots.txt')
await p.setContent('<!doctype html><html><head><link rel="stylesheet" href="/css/main.bundled.css"></head><body class="alternating-lines"><div id="c" class="chat-tile-pane" style="width:700px;background:#000"></div></body></html>')
await p.evaluate(async () => {
  const lc = await import('/client/views/live-chat.js')
  const vm = new Proxy({}, { get: (t, k) => { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return () => ({ map: new Map(), maps: {}, resolved: true, want: false, twitchChannel: '' }) }, set: (t, k, v) => { t[k] = v; return true } })
  const comp = new lc.LiveChatComponent(vm)
  comp._emotesForTab = () => ({ map: new Map(), resolved: true, want: false }); comp._badgesForTab = () => ({ maps: {}, resolved: true, want: false, twitchChannel: '' }); comp._ensureLateRefRepaint = () => {}
  const c = document.getElementById('c'); c.dataset.activeTabId = 't'
  const mk = (u, t, extra = {}) => ({ type: 'chat', platform: 'twitch', username: u, displayName: u, content: t, timestamp: Date.now(), id: u + Math.random(), color: '#8888ff', ...extra })
  const sys = (subType, text) => ({ type: 'system', subType, systemMessage: text, platform: 'twitch', timestamp: Date.now(), id: 's' + Math.random() })
  const ev = (cls, txt) => ({ type: 'stream-event', eventClass: cls, content: txt, channel: 'kripp', platform: 'twitch', color: '#8888ff', userId: '', displayName: '', timestamp: Date.now(), id: 'e' + Math.random() })
  const warm = document.createElement('div'); warm.dataset.activeTabId = 't'
  for (const u of ['a', 'b', 'c', 'd', 'e', 'f']) comp._renderChatMessageBulk(warm, mk(u, 'x'))
  const R = (m) => comp._renderChatMessageBulk(c, m)
  R(mk('viewer', 'a normal chat message', { color: '#00ffff' })); R(mk('viewer2', 'another normal message', { color: '#00ff00' }))
  R(mk('newbie', 'hello chat, first time here', { isFirstMsg: true, color: '#0000ff' })); R(mk('viewer3', 'a third normal message', { color: '#ff00ff' }))
  R(sys('sub', 'subber subscribed with Prime')); R(sys('subgift', 'gifter gifted a Tier 1 sub to bob')); R(sys('raid', '42 raiders from raider have joined')); R(sys('announcement', 'welcome to the stream'))
  R(mk('pointer', 'redeemed thing', { isRedemption: true, color: '#ffffff' })); R(mk('shouty', 'this is highlighted', { isHighlighted: true, color: '#00ffff' }))
  R(ev('event-update', 'kripp switched to Just Chatting')); R(ev('event-poll', 'kripp poll: best game?'))
  R(ev('event-raid', 'kripp raided friend with 12')); R(ev('event-sub', 'gifter gifted 5 subs'))
  R(mk('viewer4', 'a fourth normal message', { color: '#ffffff' })); R(mk('viewer5', 'a fifth normal message', { color: '#ffffff' })); R(ev('event-online', 'kripp went live — Elden Ring')) 
})
writeFileSync(process.argv[2], JSON.stringify(await p.evaluate(collect, '#c > *'), null, 1))
await p.screenshot({ path: process.argv[3] || '/tmp/claude-1000/brand-site.png', clip: { x: 0, y: 0, width: 740, height: 520 } })
await b.close()
