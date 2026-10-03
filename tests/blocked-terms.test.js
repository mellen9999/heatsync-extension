import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { SLASH_REGISTRY, slashAliasMap, slashCommandsFor } from '../src/multichat/slash-registry.js'

/**
 * The blocked-terms panel (blocked-terms.js): list / add / delete / filter,
 * the relink + not-a-mod + error states, plus the pieces that open it
 * (/blocked, the toolbar button, the right-click menu). The panel runs for
 * real against a happy-dom pane; the wiring checks read the shipped source.
 */
const ROOT = join(import.meta.dir, '..')
const dir = join(ROOT, 'src', 'multichat')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const PANEL = ['x-glyph.js', 'pane-panel.js', 'blocked-terms.js']
  .map((f) => readFileSync(join(dir, f), 'utf8'))
  .join('\n')
const INPUT = read('src', 'multichat', 'input.js')
const TOOLBAR = read('src', 'multichat', 'mod-toolbar.js')
const BG = read('chrome', 'background.js')
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
const term = (id, text) => ({ id, text, created_at: '2026-10-03T00:00:00Z' })

let win
let sent
let toasts
let reply
let prevDocument
let prevWindow

function open(login = 'SomeChannel') {
  const d = win.document
  d.body.innerHTML = '<div id="hs-mc-overlay"><div id="hs-mc-subrow"></div><div id="hs-mc-messages"></div></div>'
  const t = (k, subs = []) => `${k}${subs.length ? `:${subs.join(',')}` : ''}`
  const api = new Function(
    'document',
    'window',
    't',
    'showToast',
    'safeSendMessage',
    'resolveAutomodBroadcasterId',
    'currentTab',
    'renderMessages',
    `${PANEL}; return { openBlockedTerms, btVisible, btViewFor }`,
  )(
    d,
    win,
    t,
    (m, kind) => toasts.push([m, kind]),
    async (m) => {
      sent.push(m)
      return reply(m)
    },
    async () => '123',
    'chan',
    () => {},
  )
  return api.openBlockedTerms(login)
}

const body = () => win.document.querySelector('.hs-bt-body')
const rows = () => [...win.document.querySelectorAll('.hs-bt-row .hs-bt-text')].map((n) => n.textContent)
const key = (k, target = win.document.body) =>
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

beforeEach(() => {
  if (!Window) return
  win = new Window()
  sent = []
  toasts = []
  reply = (m) =>
    m.op === 'list' ? { ok: true, terms: [term('a', 'alpha'), term('b', '<img src=x onerror=1>')] } : { ok: true }
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

suite('blocked terms panel', () => {
  test('lists the terms and renders them as text, never markup', async () => {
    expect(await open()).toBe(true)
    await flush()
    expect(sent[0]).toEqual({ type: 'blocked_terms', op: 'list', broadcasterId: '123' })
    expect(rows()).toEqual(['alpha', '<img src=x onerror=1>'])
    expect(body().querySelector('img')).toBeNull()
    expect(win.document.querySelector('.hs-bt-count').textContent).toBe('mc_bt_count:2')
  })

  test('empty list says so', async () => {
    reply = () => ({ ok: true, terms: [] })
    await open()
    await flush()
    expect(body().textContent).toBe('mc_bt_empty')
  })

  test('missing scope shows allow + retry; allow opens the relink url', async () => {
    reply = () => ({ ok: false, error: 'relink_required' })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_bt_need_perm')
    const opened = []
    win.open = (...a) => opened.push(a)
    const allow = [...body().querySelectorAll('button')].find((b) => b.textContent === 'mc_bt_allow')
    allow.click()
    expect(opened[0][0]).toContain('/api/auth/login?scopes=blockedterms')
    expect(opened[0][2]).toBe('noopener')
    expect([...body().querySelectorAll('button')].some((b) => b.textContent === 'mc_bt_retry')).toBe(true)
  })

  test('403 reads as not a moderator, with no retry', async () => {
    reply = () => ({ ok: false, error: 'not_moderator' })
    await open()
    await flush()
    expect(body().textContent).toBe('mc_bt_not_mod')
    expect(body().querySelector('button')).toBeNull()
  })

  test('an expired heatsync session asks to sign in, not to relink twitch', async () => {
    reply = () => ({ ok: false, error: 'auth_required' })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_automod_signin')
    expect(body().textContent).not.toContain('mc_bt_allow')
  })

  test('a failed load shows the error and retry reloads', async () => {
    reply = () => ({ ok: false, error: 'http 502' })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_bt_err')
    reply = () => ({ ok: true, terms: [term('z', 'zed')] })
    ;[...body().querySelectorAll('button')].find((b) => b.textContent === 'mc_bt_retry').click()
    await flush()
    expect(rows()).toEqual(['zed'])
  })

  test('add: enter in the add field posts, newest first', async () => {
    await open()
    await flush()
    reply = (m) => ({ ok: true, term: term('n', m.text) })
    key('a')
    const add = win.document.querySelectorAll('.hs-bt-input')[1]
    add.value = '  scam link  '
    key('Enter', add)
    await flush()
    expect(sent.at(-1)).toEqual({ type: 'blocked_terms', op: 'add', broadcasterId: '123', text: 'scam link' })
    expect(rows()[0]).toBe('scam link')
    expect(add.value).toBe('')
  })

  test('add: a 1-character term never leaves the page', async () => {
    await open()
    await flush()
    const add = win.document.querySelectorAll('.hs-bt-input')[1]
    add.value = 'x'
    key('Enter', add)
    await flush()
    expect(sent.filter((m) => m.op === 'add')).toEqual([])
    expect(win.document.querySelector('.hs-bt-msg').textContent).toBe('mc_bt_short')
  })

  test('delete: d asks, n backs out, d + y removes', async () => {
    await open()
    await flush()
    key('d')
    expect(win.document.querySelector('.hs-bt-confirm')).not.toBeNull()
    key('n')
    expect(win.document.querySelector('.hs-bt-confirm')).toBeNull()
    expect(sent.filter((m) => m.op === 'remove')).toEqual([])
    key('d')
    key('y')
    await flush()
    expect(sent.at(-1)).toEqual({ type: 'blocked_terms', op: 'remove', broadcasterId: '123', id: 'a' })
    expect(rows()).toEqual(['<img src=x onerror=1>'])
  })

  test('esc backs out of a confirm without closing the panel; the next esc closes it', async () => {
    await open()
    await flush()
    key('x')
    key('Escape')
    expect(win.document.querySelector('.hs-bt-confirm')).toBeNull()
    expect(win.document.querySelector('.hs-bt')).not.toBeNull()
    key('Escape')
    expect(win.document.querySelector('.hs-bt')).toBeNull()
  })

  test('j/k move the selection, / filters', async () => {
    await open()
    await flush()
    const sel = () => win.document.querySelector('.hs-bt-sel .hs-bt-text').textContent
    expect(sel()).toBe('alpha')
    key('j')
    expect(sel()).toBe('<img src=x onerror=1>')
    key('k')
    expect(sel()).toBe('alpha')
    key('/')
    const filter = win.document.querySelector('.hs-bt-input')
    filter.value = 'ALP'
    filter.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(rows()).toEqual(['alpha'])
    expect(win.document.querySelector('.hs-bt-count').textContent).toBe('mc_bt_count_of:1,2')
  })

  test('keys stop working once the panel is closed', async () => {
    await open()
    await flush()
    key('Escape')
    key('d')
    expect(win.document.querySelector('.hs-bt-confirm')).toBeNull()
  })

  test('a 404 on delete is the state the mod wanted', async () => {
    await open()
    await flush()
    reply = () => ({ ok: false, error: 'gone' })
    key('d')
    key('Enter')
    await flush()
    expect(rows()).toEqual(['<img src=x onerror=1>'])
  })
})

describe('blocked terms helpers', () => {
  const fns = new Function(
    `${PANEL.slice(PANEL.indexOf('function btViewFor'), PANEL.indexOf('function btEl'))}; return { btVisible, btViewFor }`,
  )()
  test('error code → view', () => {
    expect(fns.btViewFor('relink_required')).toBe('perm')
    expect(fns.btViewFor('not_moderator')).toBe('notmod')
    expect(fns.btViewFor('auth_required')).toBe('auth')
    expect(fns.btViewFor('http 500')).toBe('error')
  })
  test('filter is a case-insensitive substring', () => {
    const ts = [term('1', 'Alpha'), term('2', 'beta')]
    expect(fns.btVisible(ts, 'ALP').map((x) => x.id)).toEqual(['1'])
    expect(fns.btVisible(ts, '  ').length).toBe(2)
  })
})

describe('blocked terms wiring', () => {
  test('/blocked is in the registry (mod, twitch) and in the moderation section', () => {
    const row = SLASH_REGISTRY.find((c) => c.cmd === 'blocked')
    expect(row).toMatchObject({ args: '', on: 'both', needs: 'mod', does: 'twitch' })
    expect(row.desc).toBe(row.desc.toLowerCase())
    expect(slashCommandsFor('ext').some((c) => c.cmd === 'blocked')).toBe(true)
    expect(slashAliasMap('ext').blocked).toBeUndefined()
  })

  test('/blocked dispatches to the panel and refuses off a twitch channel tab', () => {
    const at = INPUT.indexOf("if (cmd === 'blocked') {")
    expect(at).toBeGreaterThan(0)
    const branch = INPUT.slice(at, INPUT.indexOf('\n  }\n', at))
    expect(branch).toContain('openBlockedTerms(login)')
    expect(branch).toContain('mc_bt_no_channel')
    expect(branch).toContain('mc_bt_not_mod_slash')
  })

  test('the toolbar button exists, is twitch-only, and is off by default', () => {
    expect(TOOLBAR).toMatch(/blocked_terms: \{[^}]*twitchOnly: true/)
    expect(TOOLBAR).toContain('const DEFAULT_MOD_BUTTONS = []')
    const def = SETTINGS.find((s) => s.key === 'hs_mod_toolbar_buttons')
    expect(def.default).toEqual([])
    const opt = def.options.find((o) => o.value === 'blocked_terms')
    expect(opt.labelKey).toBe('mc_settings_mod_btn_blocked_terms')
    expect(EN[opt.labelKey]).toBeDefined()
  })

  test('the right-click mod menu gets the entry for twitch rows only', () => {
    expect(INPUT).toMatch(
      /if \(!isKick && !isYt\) mod\.push\(\{ label: 'blocked terms', fn: \(\) => openBlockedTerms\(modCh\) \}\)/,
    )
  })

  test('the background answers each status with its own code', () => {
    const at = BG.indexOf("message.type === 'blocked_terms'")
    const h = BG.slice(at, BG.indexOf("message.type === 'resolve_twitch_id'"))
    expect(h).toContain("'relink_required'")
    expect(h).toContain("'auth_required'")
    expect(h).toContain("'not_moderator'")
    expect(h).toContain("'rate_limited'")
    expect(h).toContain("credentials: 'omit'")
    expect(h).toContain('Bearer')
  })

  test('every key the panel asks for is in the default locale', () => {
    const src = read('src', 'multichat', 'blocked-terms.js') + INPUT + TOOLBAR
    const keys = new Set([...src.matchAll(/\bt\('(mc_bt_[a-z_]+)'/g)].map((m) => m[1]))
    expect(keys.size).toBeGreaterThan(15)
    expect([...keys].filter((k) => !EN[k])).toEqual([])
  })
})
