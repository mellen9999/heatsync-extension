import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Chat modes through heatsync.org's /api/mod/chat-settings: the cell reads the
 * channel's real settings, every toggle posts the right helix body, a 401 says
 * "link heatsync to set this", and the slash commands ride the same handler.
 * The cell runs for real against happy-dom with the background mocked; the
 * background handler and the slash wiring are checked against shipped source.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const MODES = read('src', 'multichat', 'chat-modes.js')
const INPUT = read('src', 'multichat', 'input.js')
const API = read('src', 'multichat', 'twitch-api.js')
const BG = read('chrome', 'background.js')
const REG = read('src', 'multichat', 'slash-registry.js')
const EN = JSON.parse(read('src', '_locales', 'en', 'messages.json'))

let Window = null
try {
  Window = (await import('happy-dom')).Window
} catch {
  try {
    const site = process.env.HS_SITE_DIR || join(ROOT, '..', 'heatsync')
    Window = (await import(join(site, 'node_modules', 'happy-dom', 'lib', 'index.js'))).Window
  } catch {}
}
const suite = Window ? describe : describe.skip
const flush = () => new Promise((r) => setTimeout(r, 0))

const SETTINGS = {
  slow_mode: true,
  slow_mode_wait_time: 10,
  follower_mode: false,
  follower_mode_duration: null,
  subscriber_mode: false,
  emote_mode: true,
  unique_chat_mode: false,
}

let win
let sent
let reply
let prevDocument
let prevWindow

function load() {
  return new Function(
    'document',
    'window',
    't',
    'safeSendMessage',
    `${MODES}; return { cmBody, cmSet, cmGet, cmNeedsLink, cmMountControls }`,
  )(
    win.document,
    win,
    (k, subs = []) => `${k}${subs.length ? `:${subs.join(',')}` : ''}`,
    async (m) => {
      sent.push(m)
      return reply(m)
    },
  )
}

beforeEach(() => {
  if (!Window) return
  win = new Window()
  sent = []
  reply = (m) => (m.op === 'get' ? { ok: true, settings: SETTINGS } : { ok: true, settings: null })
  prevDocument = globalThis.document
  prevWindow = globalThis.window
  globalThis.document = win.document
  globalThis.window = win
})
afterEach(() => {
  if (!Window) return
  globalThis.document = prevDocument
  globalThis.window = prevWindow
  win.close()
})

describe('cmBody — mode + value → helix fields', () => {
  const { cmBody } = new Function('t', `${MODES}; return { cmBody }`)()
  test('boolean modes', () => {
    expect(cmBody('emoteonly', true)).toEqual({ emote_mode: true })
    expect(cmBody('emoteonly', false)).toEqual({ emote_mode: false })
    expect(cmBody('subscribers', true)).toEqual({ subscriber_mode: true })
    expect(cmBody('unique', false)).toEqual({ unique_chat_mode: false })
  })
  test('followers: -1 off, 0 any follower, N minutes', () => {
    expect(cmBody('followers', -1)).toEqual({ follower_mode: false })
    expect(cmBody('followers', 0)).toEqual({ follower_mode: true, follower_mode_duration: 0 })
    expect(cmBody('followers', 30)).toEqual({ follower_mode: true, follower_mode_duration: 30 })
    expect(cmBody('followers', 999999).follower_mode_duration).toBe(129600)
  })
  test('slow: 0 off, N seconds clamped to 3–120', () => {
    expect(cmBody('slow', 0)).toEqual({ slow_mode: false })
    expect(cmBody('slow', 10)).toEqual({ slow_mode: true, slow_mode_wait_time: 10 })
    expect(cmBody('slow', 1).slow_mode_wait_time).toBe(3)
    expect(cmBody('slow', 500).slow_mode_wait_time).toBe(120)
  })
  test('unknown mode is null', () => {
    expect(cmBody('nope', true)).toBeNull()
  })
})

suite('the modes cell', () => {
  async function mount() {
    const { cmMountControls } = load()
    const d = win.document
    d.body.innerHTML = '<div class="grid"></div><div class="status" hidden></div>'
    const grid = d.querySelector('.grid')
    const status = d.querySelector('.status')
    const ok = await cmMountControls(grid, status, 'somechannel')
    await flush()
    return { ok, grid, status }
  }
  const row = (grid, mode) => grid.querySelector(`[data-mode="${mode}"]`)

  test('opens with a GET and renders the real state', async () => {
    const { ok, grid } = await mount()
    expect(ok).toBe(true)
    expect(sent[0]).toEqual({ type: 'chat_settings', op: 'get', channel: 'somechannel' })
    expect(row(grid, 'emoteonly').querySelector('.hs-cm-tog').textContent).toBe('mc_cm_on')
    expect(row(grid, 'subscribers').querySelector('.hs-cm-tog').textContent).toBe('mc_cm_off')
    expect(row(grid, 'slow').querySelector('.hs-cm-tog').textContent).toBe('mc_cm_on')
    expect(row(grid, 'slow').querySelector('.hs-cm-num').value).toBe('10')
    expect(row(grid, 'followers').querySelector('.hs-cm-num').value).toBe('')
  })

  test('each toggle posts the right body', async () => {
    const { grid } = await mount()
    const click = async (mode) => {
      sent.length = 0
      row(grid, mode).querySelector('.hs-cm-tog').click()
      await flush()
      return sent[0]
    }
    expect((await click('emoteonly')).settings).toEqual({ emote_mode: false })
    expect((await click('subscribers')).settings).toEqual({ subscriber_mode: true })
    expect((await click('unique')).settings).toEqual({ unique_chat_mode: true })
    expect((await click('slow')).settings).toEqual({ slow_mode: false })
    const f = await click('followers')
    expect(f).toEqual({
      type: 'chat_settings',
      op: 'set',
      channel: 'somechannel',
      settings: { follower_mode: true, follower_mode_duration: 0 },
    })
  })

  test('enter applies the typed value for slow and followers', async () => {
    const { grid } = await mount()
    const enter = async (mode, v) => {
      sent.length = 0
      const n = row(grid, mode).querySelector('.hs-cm-num')
      n.value = v
      n.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flush()
      return sent[0].settings
    }
    expect(await enter('slow', '45')).toEqual({ slow_mode: true, slow_mode_wait_time: 45 })
    expect(await enter('followers', '15')).toEqual({ follower_mode: true, follower_mode_duration: 15 })
  })

  test('a successful set re-renders from the returned settings', async () => {
    // the POST answers only {success}; the cell re-reads to show twitch's state
    let held = SETTINGS
    reply = (m) => {
      if (m.op === 'set') held = { ...held, ...m.settings }
      return m.op === 'get' ? { ok: true, settings: held } : { ok: true, settings: null }
    }
    const { grid } = await mount()
    row(grid, 'emoteonly').querySelector('.hs-cm-tog').click()
    await flush()
    expect(row(grid, 'emoteonly').querySelector('.hs-cm-tog').textContent).toBe('mc_cm_off')
  })

  test('a 401 on open says to link heatsync and offers the relink; the read-only rows stay', async () => {
    reply = () => ({ ok: false, error: 'relink_required' })
    const { ok, grid, status } = await mount()
    expect(ok).toBe(false)
    expect(status.hidden).toBe(false)
    expect(status.textContent).toContain('mc_cm_link')
    expect(status.querySelector('.hs-cm-btn')).not.toBeNull()
    expect(grid.querySelector('.hs-cm-tog')).toBeNull()
  })

  test('a non-mod stays read-only and silent', async () => {
    reply = () => ({ ok: false, error: 'not_moderator' })
    const { ok, status } = await mount()
    expect(ok).toBe(false)
    expect(status.textContent).toBe('')
  })

  test('a 401 on a toggle says link, a 403 says mods only, and the state does not change', async () => {
    const { grid, status } = await mount()
    reply = () => ({ ok: false, error: 'auth_required' })
    row(grid, 'unique').querySelector('.hs-cm-tog').click()
    await flush()
    expect(status.textContent).toContain('mc_cm_link')
    expect(row(grid, 'unique').querySelector('.hs-cm-tog').textContent).toBe('mc_cm_off')
    reply = () => ({ ok: false, error: 'not_moderator' })
    row(grid, 'unique').querySelector('.hs-cm-tog').click()
    await flush()
    expect(status.textContent).toContain('mc_cm_not_mod')
  })
})

describe('background handler', () => {
  const at = BG.indexOf("message.type === 'chat_settings'")
  const h = BG.slice(at, BG.indexOf("message.type === 'resolve_twitch_id'"))
  test('GETs by login and POSTs only the helix fields, with the bearer token', () => {
    expect(h).toContain('/api/mod/chat-settings')
    expect(h).toContain('?channel=${encodeURIComponent(channel)}')
    expect(h).toContain("method: 'POST'")
    expect(h).toContain('Authorization: `Bearer ${authToken}`')
    for (const k of [
      'emote_mode',
      'subscriber_mode',
      'unique_chat_mode',
      'slow_mode_wait_time',
      'follower_mode_duration',
    ]) {
      expect(h).toContain(`'${k}'`)
    }
  })
  test('POST carries platform + channel + a settings object; GET hands back the raw object', () => {
    expect(h).toContain("JSON.stringify({ platform: 'twitch', channel, settings })")
    expect(h).toContain("op === 'get' && data && typeof data === 'object' ? data : null")
  })
  test('401 → relink_required / auth_required, 403 → not_moderator', () => {
    expect(h).toContain("'relink_required' : 'auth_required'")
    expect(h).toContain("error: 'not_moderator'")
  })
})

describe('wiring', () => {
  test('the status cell mounts the controls', () => {
    expect(API).toContain('cmMountControls(grid, modeStatus, ch)')
  })
  test('the slash commands go through cmSet first, and the GQL path is only the 401 fallback', () => {
    const i = INPUT.indexOf('const twitchLeg = async')
    const leg = INPUT.slice(i, INPUT.indexOf('const [resp, kickResp]'))
    expect(leg.indexOf('cmSet(twitchTarget, cmd, value)')).toBeGreaterThan(-1)
    expect(leg.indexOf('cmNeedsLink(site)')).toBeLessThan(leg.indexOf('setTwitchChatMode('))
    // an unlinked account that hit a mode GQL can't do is told what to link
    expect(leg).toContain("t('mc_cm_link')")
  })
  test('the *off spellings resolve to "<mode> off"', () => {
    const src = INPUT.slice(INPUT.indexOf('const CHAT_MODE_OFF_FORMS'), INPUT.indexOf('// Kick supports four'))
    const map = new Function(`${src}\nreturn CHAT_MODE_OFF_FORMS`)()
    expect(map).toEqual({
      emoteonlyoff: 'emoteonly',
      subscribersoff: 'subscribers',
      uniquechatoff: 'unique',
      slowoff: 'slow',
      followersoff: 'followers',
    })
    expect(INPUT).toContain("return { cmd: CHAT_MODE_OFF_FORMS[cmd], rest: 'off' }")
    for (const a of Object.keys(map)) expect(REG).toContain(`'${a}'`)
  })
  test('copy keys exist', () => {
    for (const k of ['mc_cm_link', 'mc_cm_link_btn', 'mc_cm_not_mod']) expect(EN[k]?.message, k).toBeTruthy()
  })
})
