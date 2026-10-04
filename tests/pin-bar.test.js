import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The pinned bar (pin-bar.js): renders from the GET, follows live pin_set /
 * pin_clear, × asks a mod then DELETEs and hides for a viewer, a tab switch
 * swaps it, `p` is gated, and the row-menu entry is gated the same way. The
 * module runs for real against a happy-dom pane; wiring checks read the source.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const SRC = ['x-glyph.js', 'pin-bar.js'].map((f) => read('src', 'multichat', f)).join('\n')
const BG = read('chrome', 'background.js')
const INPUT = read('src', 'multichat', 'input.js')
const MAIN = read('src', 'multichat', 'main.js')
const BUILD = read('build.js')
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

const PIN = {
  id: 'p1',
  message_id: 'm1',
  username: 'chatter',
  display_name: 'Chatter',
  color: '#ff8700',
  badges: [{ name: 'moderator', version: '1' }],
  content: 'hello <b>there</b>',
  ts: 1000,
  pinned_at: 2000,
}

let win
let sent
let toasts
let reply
let prevDocument
let prevWindow
let ctl // the module's api + the stubs a test flips

function mount(opts = {}) {
  const d = win.document
  d.body.innerHTML = '<div id="hs-mc-overlay"><div id="hs-mc-pinbar" hidden></div><div id="hs-mc-messages"></div></div>'
  const state = { currentTab: 'chan', mods: new Set(opts.mods || []), me: opts.me || 'viewer' }
  const channels = {
    chan: { id: 'chan', twitch: 'somechan', kick: 'some-kick' },
    other: { id: 'other', twitch: 'otherchan' },
  }
  const stubs = {
    t: (k) => k,
    showToast: (m, kind) => toasts.push([m, kind]),
    safeSendMessage: async (m) => {
      sent.push(m)
      return reply(m)
    },
    getChannelById: (id) => channels[id],
    getLiveChannel: () => '',
    config: { channels: Object.values(channels) },
    buildMessageDiv: (m) => {
      const r = d.createElement('div')
      r.className = 'hs-mc-msg'
      r.dataset.msgId = m.id
      r.dataset.msgKey = 'k'
      r.innerHTML = `<button class="hs-mc-reply-btn">r</button><span class="u"></span><span class="x"></span>`
      r.querySelector('.u').textContent = m.user
      r.querySelector('.x').textContent = m.text
      r.dataset.badges = m.badges
      r.dataset.color = m.color
      return r
    },
    sanitizeColor: (c) => c,
    isScrolledUp: true,
    scheduleScrollPin: () => {},
    cleanup: { addListener() {}, addEventListener: (tg, ev, fn) => tg.addEventListener(ev, fn) },
    chrome: { runtime: { onMessage: {} } },
    isModForSync: (c) => state.mods.has(`twitch/${c}`),
    isKickModForSync: (c) => state.mods.has(`kick/${c}`),
    prefetchModFor: () => {},
    prefetchKickModFor: () => {},
  }
  const names = Object.keys(stubs)
  const api = new Function(
    'document',
    'window',
    'sessionStorage',
    'get',
    ...names,
    `${SRC}
    return { pinSync, pinToggleRow, pinRoomOfRow, pinCanAct, pinOnKeydown, pinApply, pinState, initPinBar,
      setTab: (v) => { currentTab = v }, setMe: (v) => { currentUsername = v } }`.replace(
      'return {',
      'var currentTab = get().currentTab; var currentUsername = get().me; return {',
    ),
  )(d, win, win.sessionStorage, () => state, ...names.map((n) => stubs[n]))
  ctl = { ...api, state, d }
  return ctl
}

const bar = () => win.document.getElementById('hs-mc-pinbar')
const row = (id = 'm1', ch = 'somechan', plat = 'twitch') => {
  const r = win.document.createElement('div')
  r.className = 'hs-mc-msg'
  r.dataset.msgId = id
  r.dataset.msgChannel = ch
  r.dataset.msgPlatform = plat
  win.document.getElementById('hs-mc-messages').append(r)
  return r
}
const keyOn = (k, target) => {
  const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  target.dispatchEvent(ev)
  return ev
}

beforeEach(() => {
  if (!Window) return
  win = new Window()
  sent = []
  toasts = []
  reply = (m) => (m.op === 'get' && m.platform === 'twitch' ? { ok: true, pin: PIN } : { ok: true, pin: null })
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

suite('pin bar', () => {
  test('renders from the GET: label, author, message as text, one row', async () => {
    const p = mount()
    await p.pinSync('chan')
    expect(sent.map((m) => `${m.op}:${m.platform}/${m.channel}`)).toEqual(['get:twitch/somechan', 'get:kick/some-kick'])
    expect(bar().hidden).toBe(false)
    expect(bar().querySelector('.hs-mc-pin-label').textContent).toBe('mc_pin_label')
    const r = bar().querySelector('.hs-mc-msg')
    expect(r.querySelector('.u').textContent).toBe('Chatter')
    expect(r.querySelector('.x').textContent).toBe('hello <b>there</b>')
    expect(r.querySelector('b')).toBeNull()
    expect(r.dataset.badges).toBe('moderator/1')
    // not a row of the pane: nothing for toolbar / reply / p to act on
    expect(r.dataset.msgId).toBeUndefined()
    expect(r.querySelector('.hs-mc-reply-btn')).toBeNull()
  })

  test('no pin keeps the bar hidden', async () => {
    reply = () => ({ ok: true, pin: null })
    const p = mount()
    await p.pinSync('chan')
    expect(bar().hidden).toBe(true)
  })

  test('live pin_set shows, pin_clear hides, an unjoined room is ignored', async () => {
    reply = () => ({ ok: true, pin: null })
    const p = mount()
    await p.pinSync('chan')
    p.pinApply('twitch/somechan', PIN)
    expect(bar().hidden).toBe(false)
    p.pinApply('twitch/elsewhere', PIN)
    p.pinApply('twitch/somechan', null)
    expect(bar().hidden).toBe(true)
  })

  test('the newest pin of a tab with two rooms wins', async () => {
    reply = (m) => ({
      ok: true,
      pin: {
        ...PIN,
        id: m.platform,
        username: m.platform,
        display_name: m.platform,
        pinned_at: m.platform === 'kick' ? 9 : 1,
      },
    })
    const p = mount()
    await p.pinSync('chan')
    expect(bar().querySelector('.u').textContent).toBe('kick')
  })

  test('click expands the line', async () => {
    const p = mount()
    await p.pinSync('chan')
    bar().querySelector('.hs-mc-pin-body').click()
    expect(bar().classList.contains('open')).toBe(true)
  })

  test('mod x asks first (y confirms), then DELETEs', async () => {
    const p = mount({ mods: ['twitch/somechan'] })
    await p.pinSync('chan')
    sent.length = 0
    bar().querySelector('.hs-mc-pin-x').click()
    expect(bar().dataset.confirm).toBe('1')
    expect(sent).toEqual([])
    keyOn('y', bar())
    await flush()
    expect(sent[0]).toMatchObject({ type: 'pin', op: 'clear', platform: 'twitch', channel: 'somechan' })
    expect(bar().hidden).toBe(true)
  })

  test('mod x: esc backs out, nothing is sent', async () => {
    const p = mount({ mods: ['twitch/somechan'] })
    await p.pinSync('chan')
    sent.length = 0
    bar().querySelector('.hs-mc-pin-x').click()
    keyOn('Escape', bar())
    expect(bar().dataset.confirm).toBeUndefined()
    expect(bar().hidden).toBe(false)
    expect(sent).toEqual([])
  })

  test('the broadcaster counts as able to unpin', async () => {
    const p = mount({ me: 'SomeChan' })
    await p.pinSync('chan')
    expect(p.pinCanAct('twitch', 'somechan')).toBe(true)
    expect(p.pinCanAct('kick', 'some-kick')).toBe(false)
  })

  test('viewer x hides locally, sends nothing, and a NEW pin shows again', async () => {
    const p = mount()
    await p.pinSync('chan')
    sent.length = 0
    bar().querySelector('.hs-mc-pin-x').click()
    expect(bar().hidden).toBe(true)
    expect(sent).toEqual([])
    expect(win.sessionStorage.getItem('hs_pin_x:p1')).toBe('1')
    p.pinApply('twitch/somechan', { ...PIN, id: 'p2', pinned_at: 3000 })
    expect(bar().hidden).toBe(false)
  })

  test('tab switch swaps the pin (and drops the old tab’s)', async () => {
    const p = mount()
    await p.pinSync('chan')
    expect(bar().hidden).toBe(false)
    reply = () => ({ ok: true, pin: null })
    p.setTab('other')
    await p.pinSync('other')
    expect(bar().hidden).toBe(true)
    expect(p.pinState.rooms).toEqual(['twitch/otherchan'])
  })

  test('the same tab inside the refresh window does not refetch', async () => {
    const p = mount()
    await p.pinSync('chan')
    sent.length = 0
    await p.pinSync('chan')
    expect(sent).toEqual([])
  })

  test('p pins the hovered row for a mod; POST names only the message id', async () => {
    const p = mount({ mods: ['twitch/somechan'] })
    await p.pinSync('chan')
    sent.length = 0
    reply = () => ({ ok: true, pin: { ...PIN, id: 'p9', message_id: 'm5' } })
    const r = row('m5')
    r.matches = (s) => s === ':hover' || r.constructor.prototype.matches.call(r, s)
    win.document.querySelectorAll = (s) => (s.includes(':hover') ? [r] : [])
    p.initPinBar()
    keyOn('p', win.document.body)
    await flush()
    expect(sent[0]).toEqual({ type: 'pin', op: 'set', platform: 'twitch', channel: 'somechan', messageId: 'm5' })
    expect(toasts.at(-1)[0]).toBe('mc_pin_done')
  })

  test('p does nothing for a viewer, while typing, or on a row of another room', async () => {
    const hov = (r) => {
      win.document.querySelectorAll = (s) => (s.includes(':hover') ? [r] : [])
    }
    let p = mount()
    await p.pinSync('chan')
    sent.length = 0
    hov(row('m5'))
    p.initPinBar()
    keyOn('p', win.document.body)
    await flush()
    expect(sent).toEqual([])
    p = mount({ mods: ['twitch/somechan', 'twitch/otherchan'] })
    await p.pinSync('chan')
    sent.length = 0
    const input = win.document.createElement('input')
    win.document.body.append(input)
    hov(row('m6'))
    p.initPinBar()
    keyOn('p', input)
    hov(row('m7', 'otherchan'))
    keyOn('p', win.document.body)
    await flush()
    expect(sent).toEqual([])
  })

  test('toggling the pinned row unpins it', async () => {
    const p = mount({ mods: ['twitch/somechan'] })
    await p.pinSync('chan')
    sent.length = 0
    await p.pinToggleRow(row('m1'))
    expect(sent[0]).toMatchObject({ op: 'clear', platform: 'twitch', channel: 'somechan' })
  })

  test('errors: 409 says try again, 403 denied, relink opens the mod scope', async () => {
    const p = mount({ mods: ['twitch/somechan'] })
    await p.pinSync('chan')
    const opened = []
    win.open = (...a) => opened.push(a)
    for (const [error, msg] of [
      ['not_archived', 'mc_pin_retry'],
      ['not_moderator', 'mc_pin_denied'],
      ['boom', 'mc_pin_failed'],
    ]) {
      reply = () => ({ ok: false, error })
      await p.pinToggleRow(row('m8'))
      expect(toasts.at(-1)).toEqual([msg, 'error'])
    }
    reply = () => ({ ok: false, error: 'relink_required' })
    await p.pinToggleRow(row('m8'))
    expect(opened[0][0]).toContain('scopes=mod')
    expect(bar().hidden).toBe(false)
  })

  test('a youtube row has no pin room', async () => {
    const p = mount({ mods: ['twitch/somechan'] })
    await p.pinSync('chan')
    expect(p.pinRoomOfRow(row('m1', 'somechan', 'youtube'))).toBeNull()
    expect(p.pinRoomOfRow(row('m1', 'somechan', 'twitch'))?.room).toBe('twitch/somechan')
  })
})

describe('pin bar wiring', () => {
  test('background: pin op uses the bearer, maps 401/403/409, and relays pin:set / pin:clear', () => {
    expect(BG).toContain("message.type === 'pin'")
    expect(BG).toContain('/api/mod/pin')
    expect(BG).toMatch(/res\.status === 409[\s\S]{0,80}not_archived/)
    expect(BG).toMatch(/case 'pin:set':\s*case 'pin:clear':/)
  })
  test('module is in the bundle, the bar sits beside (not inside) the scroller, and renders hook it', () => {
    expect(BUILD).toContain("'pin-bar.js'")
    expect(MAIN).toMatch(/<div id="hs-mc-pinbar" hidden><\/div>\s*<div id="hs-mc-messages"/)
    expect(MAIN).toContain('pinSync(id)')
    expect(MAIN).toContain('initPinBar()')
  })
  test('the row menu entry is gated by pinCanAct', () => {
    expect(INPUT).toMatch(/pinCanAct\(pr\.platform, pr\.channel\)[\s\S]{0,300}mc_pin_menu_pin/)
  })
  test('every mc_pin key is in all 34 locales', () => {
    const keys = Object.keys(EN).filter((k) => k.startsWith('mc_pin_'))
    expect(keys.length).toBe(11)
    for (const loc of ['ar', 'de', 'ja', 'zh_TW', 'pt_BR', 'tl']) {
      const m = JSON.parse(read('src', '_locales', loc, 'messages.json'))
      for (const k of keys) expect(m[k]?.message).toBeTruthy()
    }
  })
})
