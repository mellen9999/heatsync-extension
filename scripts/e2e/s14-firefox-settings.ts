/**
 * s14 — s13 in real Firefox, the way a firefox user changes settings: in the add-on's own page,
 * in another tab, then back to the stream. Firefox really hides the stream's tab while the
 * settings tab is in front, so every change lands on a hidden pane and is drawn on the way back.
 * Each on/off setting to its other value and back, each choice setting through its choices.
 *
 *   bun run build.js firefox --no-test && bun scripts/e2e/run.ts --only s14
 *   E2E_S14_HOSTS=twitch  one host (default twitch,kick); E2E_S14_KEYS=zebra,flame  just those
 *
 * After each change, and again after setting it back (judged with the stream's tab in front):
 *   - nothing threw: no new add-on error in firefox's console, nothing new in hs_errors
 *   - the panel is still mounted and on screen, and draws rows
 * At the end: chat still flows, the overlay's watchdogs stayed quiet.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchFirefox } from '../lib/firefox'
import { bad, info, liveChannels, ok, panel, ROOT, ringSince, rowsFlow, scenario, sleep } from './lib'
import { HIDES_PANEL, steps } from './s13-settings-sweep'

const FF_EXT = process.env.E2E_FF_EXT || join(ROOT, 'dist', 'firefox')

// run in the add-on's page: write one setting the way the settings page does, answer hs_errors' length
const WRITE = `
  const done = arguments[arguments.length - 1]
  const [k, s, v] = arguments
  const w = s === 'local'
    ? browser.storage.local.set({ [k]: v })
    : browser.storage.sync.get('ui_settings').then((o) => browser.storage.sync.set({ ui_settings: { ...(o.ui_settings || {}), [k]: v } }))
  w.then(() => browser.storage.local.get('hs_errors'))
    .then((o) => done((o.hs_errors || []).length), (e) => done(String(e)))`

function look() {
  const r = document.getElementById('hs-mc-container')?.getBoundingClientRect()
  return {
    mounted: !!r && r.width >= 120 && r.height >= 120,
    rows: document.querySelectorAll('#hs-mc-messages .hs-mc-msg').length,
    vis: document.visibilityState,
  }
}

export async function s14FirefoxSettings() {
  scenario('s14 firefox every setting flipped from the settings tab and back')
  if (!existsSync(join(FF_EXT, 'manifest.json'))) return bad(`no firefox build at ${FF_EXT}`)
  const want = (process.env.E2E_S14_HOSTS || 'twitch,kick').split(',').filter(Boolean)
  const hosts: [string, string][] = []
  if (want.includes('twitch')) hosts.push(['twitch', `https://www.twitch.tv/${(await liveChannels('twitch', 1))[0]}`])
  if (want.includes('kick')) hosts.push(['kick', `https://kick.com/${(await liveChannels('kick', 1))[0]}`])
  const ff = await launchFirefox()
  const p = ff.asPage()
  try {
    const id = await ff.install(FF_EXT)
    info(`firefox ${ff.version}, add-on ${id}`)
    const host = await ff.privileged<string>('return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname', [id])
    const stream = await ff.wd<string>('GET', '/window')
    const settings = (await ff.wd<{ handle: string }>('POST', '/window/new', { type: 'tab' })).handle
    await ff.wd('POST', '/window', { handle: settings })
    await ff.goto(`moz-extension://${host}/popup.html`)
    const front = async (h: string) => {
      await ff.wd('POST', '/window', { handle: h })
      if (h === stream && (await ff.page<string>('return document.visibilityState')) !== 'visible') await ff.ensureVisible()
    }
    // from the settings tab: the change, then back to the stream; answers hs_errors' length
    const write = async (k: string, s: string, v: unknown) => {
      await front(settings)
      const n = await ff.pageAsync<number | string>(WRITE, [k, s, v])
      await front(stream)
      if (typeof n !== 'number') throw new Error(`write ${k}: ${n}`)
      return n
    }

    for (const [name, url] of hosts) {
      await front(stream)
      await ff.goto(url)
      if (!(await rowsFlow(p, 45_000))) {
        bad(`${name}: chat never flowed`, await panel(p))
        continue
      }
      const t0 = Date.now()
      const keys = (process.env.E2E_S14_KEYS || '').split(',').filter(Boolean)
      const all = steps().filter((s) => !keys.length || keys.includes(s.key))
      info(`${name}: ${all.length} changes`)
      let errBase = (await ff.addonErrors()).length
      let hsBase = await write('hs_e2e_probe', 'local', t0)
      const broke: string[] = []
      for (const s of all) {
        const label = `${s.key}=${JSON.stringify(s.value)}`
        await write(s.key, s.scope, s.value)
        await sleep(1200)
        const on = await p.evaluate(look)
        const hsNow = await write(s.key, s.scope, s.back)
        await sleep(900)
        const off = await p.evaluate(look)
        const errs = await ff.addonErrors()
        const why: string[] = []
        if (errs.length > errBase) why.push(`add-on error: ${errs.at(-1)?.slice(0, 160)}`)
        if (hsNow > hsBase) why.push(`${hsNow - hsBase} new in hs_errors`)
        if (HIDES_PANEL[s.key] !== s.value) {
          if (!on.mounted) why.push(`panel gone while set (${on.vis})`)
          else if (!on.rows) why.push('no rows while set')
        }
        if (!off.mounted || !off.rows) why.push(`set back: ${off.mounted ? 'no rows' : 'panel gone'}`)
        errBase = errs.length
        hsBase = hsNow
        if (why.length) {
          broke.push(label)
          bad(`${name} ${label}: ${why.join('; ')}`)
        }
      }
      // the stream's tab is hidden while the settings tab is in front, and firefox throttles a hidden
      // tab's timers: the error log's 500ms write can land seconds later, after the step that caused
      // it was judged. Whatever arrived late is counted here
      await sleep(8000)
      const hsEnd = await write('hs_e2e_probe', 'local', Date.now())
      if (hsEnd > hsBase) bad(`${name}: ${hsEnd - hsBase} error(s) reached hs_errors after their step was judged`)
      if (!broke.length) ok(`${name}: all ${all.length} changes from the settings tab, nothing threw, the panel stayed and drew rows`)
      if (!(await rowsFlow(p, 90_000))) bad(`${name}: chat stopped after the sweep`, await panel(p))
      else ok(`${name}: chat still flows after the sweep`)
      const ring = await ringSince(p, t0)
      if (ring.bad.length) bad(`${name}: overlay watchdogs fired during the sweep`, ring.bad.slice(0, 6))
    }
  } finally {
    await ff.close()
  }
}
