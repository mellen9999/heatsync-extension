import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { collect, inject } from './collect.mjs'
import { launchWithExtension } from '../lib/chromium'

const certDir = mkdtempSync(join(tmpdir(), 'hs-ext-irc-cert-'))
execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-keyout',join(certDir,'key.pem'),'-out',join(certDir,'cert.pem'),'-days','1','-nodes','-subj','/CN=irc-ws.chat.twitch.tv'],{stdio:'ignore'})
const sockets = new Set<any>()
const frames: string[] = []
const server = Bun.serve({ port: 0, tls: { key: readFileSync(join(certDir,'key.pem')), cert: readFileSync(join(certDir,'cert.pem')) },
  fetch(req: Request, srv: any) { if (srv.upgrade(req)) return undefined as any; return new Response('no',{status:400}) },
  websocket: { open(ws:any){sockets.add(ws)}, close(ws:any){sockets.delete(ws)},
    message(ws:any,msg:any){ for (const line of String(msg).split('\r\n')) { if(!line) continue; frames.push(line)
      if (line.startsWith('NICK')) ws.send(`:tmi.twitch.tv 001 ${line.slice(5).trim()||'probeuser'} :Welcome, GLOBALUSERSTATE\r\n`)
      else if (line.startsWith('JOIN')) ws.send(`:probeuser!p@p.tmi.twitch.tv JOIN ${line.slice(5).trim()}\r\n`) } } } })
const push = (raw: string) => { for (const c of sockets) { try { c.send(raw) } catch (_) {} } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const prof = mkdtempSync(join(tmpdir(), 'hs-ext-real-'))
const c = await launchWithExtension(prof, ['--window-size=1500,1000', `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${server.port}`, '--ignore-certificate-errors', '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'])
try {
  await c.route('https://heatsync.org/**', (r: any) => r.abort())
  await c.route('https://www.twitch.tv/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><title>fixture</title></head><body style="margin:0"><div id="host-content" style="height:100vh">host</div><div class="right-column right-column--beside" id="rcol"></div></body></html>' }))
  await c.addCookies([{ name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },{ name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true }])
  let sw = c.serviceWorkers()[0]; if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20000 })
  const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]!
  const seed = await c.newPage(); await seed.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  await seed.evaluate(async () => { // @ts-ignore
    await chrome.storage.local.set({ chat_filter_rules: JSON.stringify([{ id: 'r1', enabled: true, action: 'highlight', color: '#ff0000', scope: 'all', match: { type: 'keyword', value: 'ruletrigger' } }]), heatsync_multichat: { channels: [{ id: 'probechan', twitch: 'probechan', kick: '', youtube: '' }] }, user_info: { username: 'probeuser' } }) })
  await seed.close()
  const p = await c.newPage()
  await p.goto('https://www.twitch.tv/probechan', { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('#hs-mc-input', { timeout: 25000 })
  for (let i = 0; i < 50 && !frames.some((f) => f.startsWith('PASS oauth:')); i++) await sleep(400)
  console.log('handshake', frames.some((f) => f.startsWith('PASS oauth:')))
  const msg = (n: string, col: string, id: string, text: string, tags = '') => push(`@display-name=${n};color=${col};user-id=${id.length+40};id=${id}${tags} :${n.toLowerCase()}!x@x.tmi.twitch.tv PRIVMSG #probechan :${text}\r\n`)
  const drv = await c.newPage(); await drv.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
  const ev = (o: any) => drv.evaluate((o: any) => new Promise((res) => { // @ts-ignore
    chrome.tabs.query({}, (tabs: any[]) => { const t = tabs.find((x) => (x.url||'').includes('twitch.tv')); // @ts-ignore
      chrome.tabs.sendMessage(t.id, o); res('sent') }) }), o)
  const un = (n: string, col: string, id: string, mid: string, sys: string, text = '', extra = '') => push(`@display-name=${n};color=${col};user-id=${id.length+40};id=${id};msg-id=${mid};system-msg=${sys.replace(/ /g,'\\s')}${extra} :tmi.twitch.tv USERNOTICE #probechan${text ? ' :' + text : ''}\r\n`)
  const nt = (mid: string, text: string) => push(`@msg-id=${mid} :tmi.twitch.tv NOTICE #probechan :${text}\r\n`)
  msg('viewerone', '#00FFFF', 'm1', 'a normal chat message'); await sleep(300)
  msg('viewertwo', '#00FF00', 'm2', 'another normal message'); await sleep(300)
  msg('newbie', '#0000FF', 'm3', 'hello chat, first time here', ';first-msg=1'); await sleep(300)
  msg('viewerthree', '#FF00FF', 'm4', 'a third normal message'); await sleep(300)
  un('subber', '#FF0000', 's1', 'sub', 'subber subscribed with Prime', '', ';msg-param-sub-plan=Prime;msg-param-cumulative-months=3'); await sleep(300)
  un('gifter', '#00FFFF', 'g1', 'subgift', 'gifter gifted a Tier 1 sub to bob', '', ';msg-param-recipient-display-name=bob;msg-param-sub-plan=1000'); await sleep(300)
  un('raider', '#FF00FF', 'r1', 'raid', '42 raiders from raider have joined', '', ';msg-param-displayName=raider;msg-param-viewerCount=42'); await sleep(300)
  un('probechan', '#00FF00', 'a1', 'announcement', 'announcement', '', ';msg-param-color=PRIMARY'); await sleep(300)
  msg('pointer', '#FFFFFF', 'p1', 'redeemed thing', ';custom-reward-id=abc-123'); await sleep(300)
  msg('shouty', '#00FFFF', 'h1', 'this is highlighted', ';msg-id=highlighted-message'); await sleep(300)
  un('cheerer', '#8888FF', 'b1', 'bitsbadgetier', 'cheerer cheered 100 bits', '', ''); await sleep(300)
  msg('ruler', '#00FF00', 'rr', 'this has ruletrigger in it'); await sleep(300)
  msg('pinger', '#FFFF00', 'pg', 'hi @probeuser https://example.com/x'); await sleep(300)
  msg('pinger2', '#FFFF00', 'pg2', 'hi again @probeuser https://example.com/y'); await sleep(300)
  msg('introer', '#00FF00', 'in', 'hi everyone', ';msg-id=user-intro'); await sleep(300)
  await ev({ type: 'stream_event', eventType: 'stream:update', channel: 'probechan', game: 'Just Chatting', prevGame: 'Elden Ring', color: '#8888ff' }); await sleep(400)
  await ev({ type: 'stream_event', eventType: 'stream:poll-start', channel: 'probechan', title: 'best game?' }); await sleep(300)
  await ev({ type: 'stream_event', eventType: 'stream:raid-in', channel: 'probechan', from: 'friend', viewers: 12 }); await sleep(300)
  await ev({ type: 'stream_event', eventType: 'stream:sub-gift', channel: 'probechan', user: 'gifter', count: 5 }); await sleep(300)
  msg('viewerfour', '#FFFFFF', 'm5', 'a fourth normal message'); await sleep(300)
  msg('viewerfive', '#FFFFFF', 'm6', 'a fifth normal message'); await sleep(300)
  console.log('waiting out the 90s went-live grace…'); await sleep(95000)
  await ev({ type: 'stream_event', eventType: 'stream:online', channel: 'probechan', game: 'Elden Ring', color: '#8888ff' }); await sleep(800)
  msg('viewersix', '#00FF00', 'm7', 'a sixth normal message'); await sleep(1500)
  writeFileSync(`${process.argv[2]}.classes.txt`, (await p.evaluate(() => [...document.querySelectorAll('#hs-mc-messages > *')].map((e: any) => `${e.className} | ${(e.textContent || '').trim().slice(0, 40)}`))).join('\n'))
  await p.evaluate(inject, ['#hs-mc-messages', 'hs-mc-msg'])
  writeFileSync(process.argv[2], JSON.stringify(await p.evaluate(collect, '#hs-mc-messages > *'), null, 1))
  const box = await p.evaluate(() => { const m = document.getElementById('hs-mc-messages')!; const r = m.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  await p.screenshot({ path: process.argv[3] || '/tmp/claude-1000/brand-ext.png', clip: { x: box.x, y: box.y, width: Math.min(box.w, 760), height: Math.min(box.h, 800) } })
} finally {
  await Promise.race([c.close().catch(()=>{}), sleep(20000)])
  server.stop(true); rmSync(certDir, { recursive: true, force: true })
}
process.exit(0)
