import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchWithExtension } from '../lib/chromium'
import { startMockIrc } from '../lib/mock-irc'
import { artOfUrl, emotePng } from './store-cast'
import { closeContext, until } from './lib'

/**
 * The stage the store screenshots are shot on: the BUILT extension in a real browser, its panel
 * popped out to fill the window, fed lines from fixtures only. Twitch is a local wss mock; kick and
 * youtube lines are handed to the page the way the background hands them; every other host the
 * panel reaches for is answered here or refused. Nothing real is contacted and nothing real is shown.
 */

/** device pixels per css pixel: the panel is drawn at 2x so its text reads at thumbnail size */
export const SCALE = 2
export const SHOT_W = 1280
export const SHOT_H = 800
/** the caption strip above the panel, in device pixels */
export const CAP_H = 56

const CORS = { 'access-control-allow-origin': '*' }
const PAGE = '<!doctype html><html><head><title>fixture</title></head><body style="margin:0;background:#000"><div class="chat-shell" style="height:100vh"></div></body></html>'

export interface ChannelCfg {
  id: string
  twitch?: string
  kick?: string
  youtube?: string
}
export interface EmoteRec {
  name: string
  url: string
  source: string
  hash?: string
  animated?: boolean
}
export interface StageOpts {
  /** the tabs, in order; the first one is the one opened */
  channels: ChannelCfg[]
  /** the opened channel's emote set, the same for its twitch, kick and youtube rooms */
  room: EmoteRec[]
  /** the viewer's own heatsync emotes */
  inventory?: EmoteRec[]
  /** picture names (the picker's recents row), newest first: "name\nhost/id" */
  recent?: string[]
  /** extra ui settings (storage.sync ui_settings) */
  settings?: Record<string, unknown>
  /** name colour by youtube author id (the panel reads a chosen colour from the paints batch) */
  ytColors?: Record<string, string>
  /** the viewer's own login: mentions of it light up */
  viewer: string
}

export type Stage = Awaited<ReturnType<typeof bootStage>>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function bootStage(o: StageOpts) {
  const irc = startMockIrc()
  if (!irc) throw new Error('openssl is missing: the mock twitch server has no certificate to serve')
  const prof = mkdtempSync(join(tmpdir(), 'hs-ext-shots-'))
  // no colour fonts: the panel's icons are text glyphs (the gear, the reply arrow) and a machine
  // that has a colour emoji font draws them as little coloured pictures, outside the palette
  const fontsConf = join(prof, 'fonts.conf')
  writeFileSync(
    fontsConf,
    '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><selectfont><rejectfont><pattern><patelt name="color"><bool>true</bool></patelt></pattern></rejectfont></selectfont></fontconfig>',
  )
  const ch = o.channels[0]
  const key = (ch.twitch || ch.kick || ch.id).toLowerCase()
  const c = await launchWithExtension(
    prof,
    [
      `--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1:${irc.port}, MAP heatsync.org 127.0.0.1:9`,
      '--ignore-certificate-errors',
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
    ],
    {
      viewport: { width: SHOT_W / SCALE, height: (SHOT_H - CAP_H) / SCALE },
      deviceScaleFactor: SCALE,
      env: { ...process.env, FONTCONFIG_FILE: fontsConf },
    },
  )
  const errors: string[] = []
  const stop = async () => {
    irc.stop()
    await closeContext(c, 'store shots', prof)
    rmSync(prof, { recursive: true, force: true })
  }
  try {
    // heatsync.org answers the one question the panel asks that changes how a line looks: a chosen
    // name colour. Everything else of it is refused, like every emote provider's api
    await c.route('https://heatsync.org/**', (r: any) => {
      const u = new URL(r.request().url())
      if (u.pathname !== '/api/paints') return r.abort()
      const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean)
      const paints: Record<string, null> = {}
      const colors: Record<string, string> = {}
      for (const id of ids) {
        paints[id] = null
        const col = o.ytColors?.[id.replace(/^yt_/, '')]
        if (col) colors[id] = col
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paints, colors, plus: {}, badges: {} }) })
    })
    for (const h of ['https://api.frankerfacez.com/**', 'https://7tv.io/**', 'https://api.7tv.app/**', 'https://api.betterttv.net/**'])
      await c.route(h, (r: any) => r.abort())
    // every emote picture is one of ours, whichever host the panel asks for it
    for (const h of ['cdn.7tv.app', 'cdn.betterttv.net', 'cdn.frankerfacez.com', 'static-cdn.jtvnw.net', 'files.kick.com', 'cdn.heatsync.org']) {
      await c.route(`https://${h}/**`, (r: any) => {
        const art = artOfUrl(r.request().url())
        if (!art) return r.abort()
        return r.fulfill({ status: 200, contentType: 'image/png', body: emotePng(art), headers: CORS })
      })
    }
    await c.route('https://www.twitch.tv/**', (r: any) => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }))
    await c.addCookies([
      { name: 'auth-token', value: 'harnesstoken0000', domain: '.twitch.tv', path: '/', secure: true },
      { name: 'login', value: o.viewer, domain: '.twitch.tv', path: '/', secure: true },
    ])

    let sw = c.serviceWorkers()[0]
    if (!sw) sw = await c.waitForEvent('serviceworker', { timeout: 20_000 })
    const id = sw.url().match(/chrome-extension:\/\/([a-p]+)\//)?.[1]
    if (!id) throw new Error('could not resolve the extension id')
    const ep = await c.newPage()
    await ep.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'load' })
    await ep.evaluate(
      async ([channels, viewer, inventory, settings]: [ChannelCfg[], string, EmoteRec[], Record<string, unknown>]) => {
        // @ts-ignore — extension page
        await chrome.storage.local.set({
          heatsync_multichat: { channels: channels.map((x) => ({ twitch: '', kick: '', youtube: '', ...x })) },
          user_info: { username: viewer },
          global_emotes: [],
          emote_inventory: inventory,
          // the first-run tour is for a first run: the shots show the product as it is lived in
          hs_tour_seen: true,
        })
        // @ts-ignore
        await chrome.storage.sync.set({ ui_settings: settings })
      },
      [o.channels, o.viewer, o.inventory || [], o.settings || {}] as [ChannelCfg[], string, EmoteRec[], Record<string, unknown>],
    )

    // the room's emote sets, the way the background holds them after a real fetch
    const seedRoom = (tell: boolean) =>
      sw.evaluate(
        async ([emotes, tell, name, legs]: [EmoteRec[], boolean, string, string[]]) => {
          for (const leg of legs) {
            // @ts-ignore — service worker globals
            channelEmotesMap[`${leg}/${name}`] = emotes
            // @ts-ignore
            channelEmotesFetchedAt[`${leg}/${name}`] = Date.now()
            // @ts-ignore
            await bgPersistChannelEmotes(`${leg}/${name}`)
            // @ts-ignore
            if (tell) broadcastToTabs({ type: 'channel_emotes_update', channelOwner: name, platform: leg, emotes })
          }
        },
        [o.room, tell, key, ['twitch', 'kick', 'youtube']] as [EmoteRec[], boolean, string, string[]],
      )
    await seedRoom(false)

    const p = await c.newPage()
    p.on('pageerror', (e: unknown) => errors.push(String(e).slice(0, 300)))
    if (o.recent) await p.addInitScript((r: string[]) => localStorage.setItem('hs-mc-recent-emotes', JSON.stringify(r)), o.recent)
    await p.goto(`https://www.twitch.tv/popout/${key}/chat`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#hs-mc-messages', { timeout: 30_000 })
    if (!(await until(p, () => irc.frames.some((f) => f.startsWith('JOIN')), 20_000))) throw new Error('the twitch room was never joined')
    // every provider fetch is refused, so the background settles on an empty set: hand it the room again
    await p.waitForTimeout(2500)
    await seedRoom(true)
    await p.waitForTimeout(1200)

    // what the background's broadcast does, aimed at the popout
    const toTab = (m: unknown) =>
      ep.evaluate(
        ({ m, key }: { m: unknown; key: string }) =>
          new Promise<number>((res) => {
            // @ts-ignore — extension page
            chrome.tabs.query({}, (tabs: any[]) => {
              const hit = tabs.filter((t) => (t.url || '').includes(`twitch.tv/popout/${key}/`))
              // @ts-ignore
              for (const t of hit) chrome.tabs.sendMessage(t.id, m, () => void chrome.runtime.lastError)
              res(hit.length)
            })
          }),
        { m, key },
      )

    // one tick per line, so every line has its own second and the order is the order written
    let n = 0
    const clock = Date.now() - 600_000
    const at = () => clock + ++n * 9_000
    return {
      c,
      p,
      ep,
      sw,
      irc,
      key,
      errors,
      stop,
      toTab,
      /** a twitch chat line; `tags` are extra raw tags (";first-msg=1") */
      async tw(who: string, color: string, text: string, tags = '') {
        const login = who.toLowerCase()
        const id = `t-${n + 1}`
        irc.push(
          `@badges=;color=${color};display-name=${who};id=${id};room-id=1;tmi-sent-ts=${at()};user-id=${1000 + n}${tags} :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #${key} :${text}\r\n`,
        )
        await sleep(260)
        return id
      },
      /** a twitch USERNOTICE: a sub, a raid, an announcement */
      async notice(who: string, color: string, tags: string, system: string, said = '') {
        const login = who.toLowerCase()
        irc.push(
          `@badges=;color=${color};display-name=${who};login=${login};${tags};system-msg=${system.replace(/ /g, '\\s')};user-id=${2000 + n};id=u-${n + 1};room-id=1;tmi-sent-ts=${at()} :tmi.twitch.tv USERNOTICE #${key}${said ? ` :${said}` : ''}\r\n`,
        )
        await sleep(260)
      },
      async kick(who: string, color: string, text: string, extra: Record<string, unknown> = {}) {
        await toTab({ type: 'kick_chat_message', data: { channel: key, username: who, content: text, id: `k-${n + 1}`, timestamp: at(), color, senderId: 3000 + n, ...extra } })
        await sleep(260)
      },
      async yt(who: string, authorId: string, text: string) {
        await toTab({ type: 'youtube_chat_batch', channelId: ch.id, messages: [{ id: `y-${n + 1}`, user: who, text, time: at(), authorChannelId: authorId }] })
        await sleep(520)
      },
      /** the panel has stopped moving: no loading line, every picture drawn, the same boxes twice running */
      async settle() {
        const quiet = () =>
          p.evaluate(() => {
            const root = document.getElementById('hs-mc-container')
            if (!root) return null
            if ((root as HTMLElement).innerText.includes('loading emotes')) return null
            const imgs = [...root.querySelectorAll('img')] as HTMLImageElement[]
            if (imgs.some((i) => !i.complete)) return null
            const m = document.getElementById('hs-mc-messages')
            return `${m?.scrollHeight}:${m?.scrollTop}:${m?.children.length}`
          })
        let last: string | null = null
        let held = 0
        for (let w = 0; w < 60_000 && held < 3; w += 500) {
          const now = await quiet()
          held = now !== null && now === last ? held + 1 : 0
          last = now
          await p.waitForTimeout(500)
        }
        if (held < 3) throw new Error('the panel never settled (still loading emotes or moving)')
        // a chat that has scrolled keeps a half row at its top, and tab-complete's line sits over the
        // bottom of it: leave those rows out of the picture, as if the room had said less, so every
        // row on screen is a whole one with nothing across it
        await p.evaluate(() => {
          const m = document.getElementById('hs-mc-messages')
          if (!m) return
          const rows = [...m.children] as HTMLElement[]
          const top = m.getBoundingClientRect().top
          for (const row of rows) {
            if (row.getBoundingClientRect().top >= top - 0.5) break
            row.style.display = 'none'
          }
          const tip = document.getElementById('hs-mc-cycle-tooltip')
          const cover = tip && getComputedStyle(tip).display !== 'none' ? tip.getBoundingClientRect().top : Infinity
          for (const row of rows.reverse()) {
            if (row.style.display === 'none') continue
            if (row.getBoundingClientRect().bottom <= cover) break
            row.style.display = 'none'
          }
        })
        await p.waitForTimeout(500)
      },
    }
  } catch (e) {
    await stop()
    throw e
  }
}
