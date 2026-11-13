import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { PLATFORMS, closeContext, errors, fail, fixtureHtml, ok, until } from './lib'

/**
 * One heatsync send said on twitch, kick and youtube is ONE row in a merged tab:
 * the earliest leg stands for the line and the others fold into it. A moderator
 * removes ONE platform's copy, often a copy that folded in and has no row of its
 * own. The row is the line too, so it must go grey whichever copy was removed.
 *
 * Twitch is a real socket (the mock irc, CLEARMSG off the wire). Kick, youtube
 * and the origin words are delivered the way the background hands them to a tab
 * (chrome.tabs.sendMessage from an extension page), as the youtube deletion check
 * does. heatsync.org and kick.com are answered locally; nothing real is contacted.
 */
const CH = 'simul'
const FAN = 'simulfan'

export async function simulcastModCheck({ dim }: { dim: boolean }) {
  console.log(`\n── a mod removing any copy of a simulcast send takes its one row (dim timeouts: ${dim ? 'on' : 'off'}) ──`)
  const irc = startMockIrc()
  if (!irc) {
    console.log('  ! SKIPPED — openssl not available, so the mock irc server has no cert.')
    console.log('    a removal of a folded simulcast copy is going UNVERIFIED in this run.')
    return
  }
  const { frames, push } = irc
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-simulmod-'))
  const c = await launchWithExtension(prof, [
    '--window-size=1500,900',
    `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}`,
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
  ])
  try {
    await c.route('https://heatsync.org/**', (r: any) => r.abort())
    await c.route('https://kick.com/**', (r: any) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 111, chatroom: { id: 222 } }) }),
    )
    await c.route(PLATFORMS[0].glob, (r: any) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml(PLATFORMS[0].body) }),
    )
    await c.addCookies([
      { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
      { name: 'login', value: 'probeuser', domain: '.twitch.tv', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) fail('could not resolve the extension id for the simulcast check')

    const ep = await c.newPage()
    await ep.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await ep.evaluate(async ({ ch, dim }: { ch: string; dim: boolean }) => {
      // @ts-ignore — extension page
      await chrome.storage.local.set({
        heatsync_multichat: { channels: [{ id: ch, twitch: ch, kick: ch, youtube: `@${ch}` }] },
        user_info: { username: 'probeuser' },
        hs_dim_timeouts: dim,
      })
    }, { ch: CH, dim })

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(`simulcast-mod: ${String(e).slice(0, 300)}`))
    await p.goto(`https://www.twitch.tv/${CH}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-messages', { timeout: 25_000 })
    if (!(await until(p, () => frames.some((f) => f === `JOIN #${CH}`)))) {
      fail(`the twitch channel was never joined (frames: ${JSON.stringify(frames.slice(0, 8))})`)
    }

    // what background.js's broadcastToTabs does, aimed at the channel page
    const toTab = (m: unknown) =>
      ep.evaluate(
        ({ m, ch }: { m: any; ch: string }) =>
          new Promise<number>((res) => {
            // @ts-ignore — extension page
            chrome.tabs.query({}, (tabs: any[]) => {
              const hit = tabs.filter((t) => (t.url || '').includes(`twitch.tv/${ch}`))
              for (const t of hit) {
                // @ts-ignore
                chrome.tabs.sendMessage(t.id, m, () => void chrome.runtime.lastError)
              }
              res(hit.length)
            })
          }),
        { m, ch: CH },
      )
    const rowsWith = (text: string) =>
      p.evaluate(
        (text: string) =>
          [...document.querySelectorAll('#hs-mc-messages .hs-mc-msg')]
            .filter((r) => (r.textContent || '').includes(text))
            .map((r) => ({
              cleared: r.classList.contains('hs-mc-msg-cleared'),
              plat: (r as HTMLElement).dataset.msgPlatform || '',
              text: (r.textContent || '').trim().slice(0, 120),
            })),
        text,
      )

    // The content script registers its kick/youtube listeners a beat after the
    // overlay mounts; a bystander line on each platform proves both are live
    // before anything below depends on them.
    const t0 = Date.now()
    const ready = await until(p, async () => {
      await toTab({
        type: 'kick_chat_message',
        data: { channel: CH, username: 'kickbystander', content: 'kick is listening', id: 'k-ready', timestamp: t0 },
      })
      await toTab({
        type: 'youtube_chat_batch',
        channelId: CH,
        messages: [{ id: 'y-ready', user: 'ytbystander', text: 'youtube is listening', time: t0, authorChannelId: 'UCbystander0000000000000' }],
      })
      const all = await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')
      return all.includes('kick is listening') && all.includes('youtube is listening')
    })
    push(`@display-name=twbystander;color=#FFFF00;user-id=902;id=t-ready :twbystander!b@b.tmi.twitch.tv PRIVMSG #${CH} :twitch is listening\r\n`)
    await until(p, async () => (await rowsWith('twitch is listening')).length === 1)
    if (!ready) {
      const all = await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')
      fail(`the kick and youtube bystander lines never rendered in the merged tab: ${JSON.stringify(all.slice(0, 300))}`)
    }

    let n = 0
    /**
     * One send on every platform, the `first` leg earliest so it stands for the
     * row and the others fold in. Origins first, as the server usually wins.
     */
    const say = async (first: 'twitch' | 'kick' | 'youtube') => {
      n++
      const text = `one line on three platforms ${n}`
      const sid = `send-${n}`
      const ids = { twitch: `t-send-${n}`, kick: `k-send-${n}`, youtube: `y-send-${n}` }
      const base = Date.now()
      const at = (pl: string) => base + (pl === first ? 0 : 400)
      for (const pl of ['twitch', 'kick', 'youtube'] as const) {
        await toTab({ type: 'chat_origin', platform: pl, channel: CH, id: ids[pl], sendId: sid })
      }
      push(
        `@display-name=${FAN};color=#00FFFF;user-id=900;id=${ids.twitch};tmi-sent-ts=${at('twitch')} ` +
          `:${FAN}!s@s.tmi.twitch.tv PRIVMSG #${CH} :${text}\r\n`,
      )
      await toTab({
        type: 'kick_chat_message',
        data: { channel: CH, username: FAN, content: text, id: ids.kick, timestamp: at('kick') },
      })
      await toTab({
        type: 'youtube_chat_batch',
        channelId: CH,
        messages: [{ id: ids.youtube, user: FAN, text, time: at('youtube'), authorChannelId: 'UCsimulfan00000000000000' }],
      })
      // every leg has landed when the row stands for all three: one row, [H]
      const one = await until(p, async () => {
        const rows = await rowsWith(text)
        return rows.length === 1
      }, 8000)
      const rows = await rowsWith(text)
      if (!one || rows.length !== 1) fail(`send ${n} (${first} first) is not one row: ${JSON.stringify(rows)}`)
      // let a late leg land and the fold settle before the removal
      await p.waitForTimeout(1200)
      const settled = await rowsWith(text)
      if (settled.length !== 1) fail(`send ${n} split after settling: ${JSON.stringify(settled)}`)
      return { text, ids }
    }
    // dim on: the row stays, grey and readable. dim off: the row is gone.
    const taken = (rows: Array<{ cleared: boolean }>) => (dim ? rows.length === 1 && rows[0].cleared : rows.length === 0)
    const missed: string[] = []
    const takes = async (text: string, what: string) => {
      const done = await until(p, async () => taken(await rowsWith(text)), 6000)
      if (done) return ok(what)
      missed.push(`${what}: ${JSON.stringify(await rowsWith(text))}`)
      console.log(`✗ ${what}`)
    }

    // 1. drawn from twitch; kick deletes ITS copy
    {
      const { text, ids } = await say('twitch')
      await toTab({ type: 'kick_moderation', action: 'delete', channel: CH, targetMsgId: ids.kick })
      await takes(text, 'a kick delete of the kick copy takes the row twitch stands for')
    }
    // 2. drawn from twitch; youtube deletes ITS copy
    {
      const { text, ids } = await say('twitch')
      await toTab({ type: 'youtube_delete', data: { messageIds: [ids.youtube] } })
      await takes(text, 'a youtube delete of the youtube copy takes the row twitch stands for')
    }
    // 3. drawn from kick; twitch deletes ITS copy (CLEARMSG off the wire)
    {
      const { text, ids } = await say('kick')
      push(`@login=${FAN};target-msg-id=${ids.twitch} :tmi.twitch.tv CLEARMSG #${CH} :${text}\r\n`)
      await takes(text, 'a twitch CLEARMSG of the twitch copy takes the row kick stands for')
    }
    // 4. drawn from youtube; a kick timeout of the sender
    {
      const { text } = await say('youtube')
      await toTab({ type: 'kick_moderation', action: 'timeout', channel: CH, targetUser: FAN, banDuration: 600 })
      await takes(text, 'a kick timeout of the sender takes the row youtube stands for')
    }
    // 5. drawn from kick; a youtube ban of the sender's channel
    {
      const { text } = await say('kick')
      await toTab({ type: 'youtube_delete', data: { authorChannelIds: ['UCsimulfan00000000000000'] } })
      await takes(text, 'a youtube ban of the sender takes the row kick stands for')
    }

    // a ban names a login on ONE platform: the same name elsewhere is someone else
    push(`@ban-duration=600;target-user-id=901 :tmi.twitch.tv CLEARCHAT #${CH} :kickbystander\r\n`)
    await toTab({ type: 'kick_moderation', action: 'timeout', channel: CH, targetUser: 'twbystander', banDuration: 600 })
    await until(p, async () => /timed out/i.test(await p.evaluate(() => document.getElementById('hs-mc-messages')?.textContent || '')))
    await p.waitForTimeout(1500)
    for (const t of ['kick is listening', 'youtube is listening', 'twitch is listening']) {
      const rows = await rowsWith(t)
      if (rows.length !== 1 || rows[0].cleared) missed.push(`a removal reached a bystander: ${JSON.stringify(rows)}`)
    }
    if (missed.length) fail(`${missed.length} removal(s) went wrong:\n  ${missed.join('\n  ')}`)
    ok('a ban on one platform leaves the same name on another alone, and every other line too')
  } finally {
    irc.stop()
    await closeContext(c, 'simulcast mod', prof)
    rmSync(prof, { recursive: true, force: true })
  }
}
