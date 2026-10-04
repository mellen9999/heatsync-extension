import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'
import { SLASH_REGISTRY, slashAliasMap, slashCommandsFor } from '../src/multichat/slash-registry.js'

/**
 * The mod suite (mod-suite.js + mod-suite-calls.js): shield / unban requests /
 * automod / chatters in one pane panel, plus warn and shoutout, and the pieces
 * that open them (/modtools /shield /warn /shoutout /unbanrequests, the row
 * menu, the toolbar button). The panel runs for real against a happy-dom pane;
 * the wiring checks read the shipped source.
 */
const ROOT = join(import.meta.dir, '..')
const dir = join(ROOT, 'src', 'multichat')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const PANEL = ['x-glyph.js', 'pane-panel.js', 'mod-suite-calls.js', 'mod-suite.js']
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
const req = (id, who, text, status = 'pending') => ({
  id,
  user_login: who,
  user_name: who.toUpperCase(),
  text,
  status,
  created_at: `2026-10-0${id}T00:00:00Z`,
  resolved_at: null,
  resolution_text: null,
})
const AM = {
  overall_level: 1,
  disability: 1,
  aggression: 1,
  sexuality_sex_or_gender: 1,
  misogyny: 1,
  bullying: 1,
  swearing: 1,
  race_ethnicity_or_religion: 1,
  sex_based_terms: 1,
}

let win
let sent
let toasts
let reply
let prevDocument
let prevWindow
let api

function boot() {
  const d = win.document
  d.body.innerHTML = '<div id="hs-mc-overlay"><div id="hs-mc-subrow"></div><div id="hs-mc-messages"></div></div>'
  const t = (k, subs = []) => `${k}${subs.length ? `:${subs.join(',')}` : ''}`
  api = new Function(
    'document',
    'window',
    't',
    'showToast',
    'safeSendMessage',
    'currentTab',
    'renderMessages',
    `${PANEL}; return { openModSuite, msWarnPrompt, msShoutout, msChattersVisible, msViewFor, msCall }`,
  )(
    d,
    win,
    t,
    (m, kind) => toasts.push([m, kind]),
    async (m) => {
      sent.push(m)
      return reply(m)
    },
    'chan',
    () => {},
  )
}

const open = (cell) => api.openModSuite('SomeChannel', cell)
const body = () => win.document.querySelector('.hs-ms-body')
const msgLine = () => win.document.querySelector('.hs-ms-msg').textContent
const rows = () => [...win.document.querySelectorAll('.hs-ms-row .hs-ms-text')].map((n) => n.textContent)
const buttons = (label) => [...win.document.querySelectorAll('button')].filter((b) => b.textContent === label)
const key = (k, target = win.document.body) =>
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const activeCell = () => win.document.querySelector('.hs-ms-cells .hs-ms-on').textContent

beforeEach(() => {
  if (!Window) return
  win = new Window()
  sent = []
  toasts = []
  reply = (m) => {
    if (m.op === 'shield_get') return { ok: true, data: { is_active: false } }
    if (m.op === 'shield_set') return { ok: true, data: { is_active: m.active } }
    if (m.op === 'unban_list')
      return { ok: true, data: { requests: [req(1, 'old', 'let me back'), req(2, 'new', '<img src=x onerror=1>')] } }
    if (m.op === 'unban_resolve') return { ok: true, data: {} }
    if (m.op === 'automod_get') return { ok: true, data: { ...AM } }
    if (m.op === 'automod_set') return { ok: true, data: {} }
    if (m.op === 'chatters')
      return {
        ok: true,
        data: {
          total: 3,
          chatters: [
            { user_login: 'alice', user_name: 'Alice' },
            { user_login: 'bob', user_name: 'Bobby' },
            { user_login: 'x1', user_name: '<b>x</b>' },
          ],
        },
      }
    return { ok: true, data: {} }
  }
  prevDocument = globalThis.document
  prevWindow = globalThis.window
  globalThis.document = win.document
  globalThis.window = win
  boot()
})
afterEach(() => {
  if (!Window) return
  globalThis.document = prevDocument
  globalThis.window = prevWindow
  win.close()
})

suite('mod suite panel — shield', () => {
  test('opens on shield and reads the channel state', async () => {
    expect(await open()).toBe(true)
    await flush()
    expect(sent[0]).toEqual({ type: 'mod_suite', channel: 'somechannel', op: 'shield_get' })
    expect(body().textContent).toContain('mc_ms_shield_off')
    expect(activeCell()).toBe('mc_ms_cell_shield')
  })

  test('turning shield ON asks first; n backs out, y sends', async () => {
    await open()
    await flush()
    key('s')
    expect(body().textContent).toContain('mc_ms_shield_confirm')
    key('n')
    expect(sent.filter((m) => m.op === 'shield_set')).toEqual([])
    key('s')
    key('y')
    await flush()
    expect(sent.at(-1)).toEqual({ type: 'mod_suite', channel: 'somechannel', op: 'shield_set', active: true })
    expect(body().textContent).toContain('mc_ms_shield_on')
    expect(msgLine()).toBe('mc_ms_shield_now_on')
  })

  test('turning shield OFF does not ask', async () => {
    reply = (m) =>
      m.op === 'shield_get'
        ? { ok: true, data: { is_active: true, last_activated_at: '2026-10-03T00:00:00Z' } }
        : { ok: true, data: { is_active: false } }
    await open()
    await flush()
    key('s')
    await flush()
    expect(sent.at(-1)).toMatchObject({ op: 'shield_set', active: false })
    expect(body().textContent).toContain('mc_ms_shield_off')
  })

  test("a refusal says the server's words and leaves the state", async () => {
    await open()
    await flush()
    reply = () => ({ ok: false, error: 'error', message: 'twitch said no' })
    key('s')
    key('y')
    await flush()
    expect(msgLine()).toBe('twitch said no')
    expect(body().textContent).toContain('mc_ms_shield_off')
  })
})

suite('mod suite panel — states', () => {
  test('missing scope shows allow + retry; allow opens the modsuite relink', async () => {
    reply = () => ({ ok: false, error: 'relink_required', message: '' })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_ms_need_perm')
    const opened = []
    win.open = (...a) => opened.push(a)
    buttons('mc_ms_allow')[0].click()
    expect(opened[0][0]).toContain('/api/auth/login?scopes=modsuite')
    expect(opened[0][2]).toBe('noopener')
    expect(buttons('mc_ms_retry').length).toBe(1)
  })

  test('403 reads as not a moderator, with no retry', async () => {
    reply = () => ({ ok: false, error: 'not_moderator', message: '' })
    await open()
    await flush()
    expect(body().textContent).toBe('mc_ms_not_mod')
    expect(body().querySelector('button')).toBeNull()
  })

  test('an expired heatsync session asks to sign in, not to relink twitch', async () => {
    reply = () => ({ ok: false, error: 'auth_required' })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_automod_signin')
    expect(body().textContent).not.toContain('mc_ms_allow')
  })

  test('a 503 shows an error with retry; retry reloads', async () => {
    reply = () => ({ ok: false, error: 'error', message: 'down' })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_ms_err')
    reply = () => ({ ok: true, data: { is_active: false } })
    buttons('mc_ms_retry')[0].click()
    await flush()
    expect(body().textContent).toContain('mc_ms_shield_off')
  })

  test('h / l and 1-4 switch cells; each loads once', async () => {
    await open()
    await flush()
    key('l')
    await flush()
    expect(activeCell()).toBe('mc_ms_cell_unban')
    expect(sent.at(-1)).toEqual({ type: 'mod_suite', channel: 'somechannel', op: 'unban_list', status: 'pending' })
    key('h')
    key('l')
    expect(sent.filter((m) => m.op === 'unban_list').length).toBe(1)
    key('4')
    await flush()
    expect(activeCell()).toBe('mc_ms_cell_chatters')
    key('h')
    key('h')
    expect(activeCell()).toBe('mc_ms_cell_unban')
  })

  test('esc closes the panel and its keys stop', async () => {
    await open()
    await flush()
    key('Escape')
    expect(win.document.querySelector('.hs-ms')).toBeNull()
    key('s')
    expect(sent.filter((m) => m.op === 'shield_set')).toEqual([])
  })
})

suite('mod suite panel — unban requests', () => {
  test('lists newest first as text, never markup', async () => {
    await open('unban')
    await flush()
    expect(rows()).toEqual(['NEW: <img src=x onerror=1>', 'OLD: let me back'])
    expect(body().querySelector('img')).toBeNull()
    expect(win.document.querySelector('.hs-ms-count').textContent).toBe('mc_ms_ub_count:2')
  })

  test('deny: d asks, a reason rides along, enter sends, the row goes', async () => {
    await open('unban')
    await flush()
    key('d')
    expect(win.document.querySelector('.hs-ms-confirm')).not.toBeNull()
    const reason = win.document.querySelector('.hs-ms-reasonbox')
    reason.value = 'not yet'
    reason.dispatchEvent(new win.Event('input', { bubbles: true }))
    key('Enter', reason)
    await flush()
    expect(sent.at(-1)).toEqual({
      type: 'mod_suite',
      channel: 'somechannel',
      op: 'unban_resolve',
      id: 2,
      status: 'denied',
      text: 'not yet',
    })
    expect(rows()).toEqual(['OLD: let me back'])
    expect(msgLine()).toBe('mc_ms_ub_denied:NEW')
  })

  test('approve with no reason sends no text; esc backs out first', async () => {
    await open('unban')
    await flush()
    key('a')
    key('Escape', win.document.querySelector('.hs-ms-reasonbox'))
    expect(win.document.querySelector('.hs-ms-confirm')).toBeNull()
    expect(win.document.querySelector('.hs-ms')).not.toBeNull()
    key('j')
    key('a')
    key('y')
    await flush()
    const m = sent.at(-1)
    expect(m).toMatchObject({ op: 'unban_resolve', id: 1, status: 'approved' })
    expect('text' in m).toBe(false)
  })

  test('f moves to the next status and reloads with it', async () => {
    await open('unban')
    await flush()
    key('f')
    await flush()
    expect(sent.at(-1)).toMatchObject({ op: 'unban_list', status: 'approved' })
  })

  test('a failed resolve keeps the row and says why', async () => {
    await open('unban')
    await flush()
    reply = () => ({ ok: false, error: 'error', message: 'already resolved' })
    key('d')
    key('y')
    await flush()
    expect(rows().length).toBe(2)
    expect(msgLine()).toBe('already resolved')
  })
})

suite('mod suite panel — automod', () => {
  test('0-4 sets the overall level, optimistic, one key per call', async () => {
    await open('automod')
    await flush()
    expect(body().querySelector('.hs-ms-on').textContent).toBe('1')
    key('3')
    expect(body().querySelector('.hs-ms-on').textContent).toBe('3')
    await flush()
    expect(sent.at(-1)).toEqual({
      type: 'mod_suite',
      channel: 'somechannel',
      op: 'automod_set',
      key: 'overall_level',
      level: 3,
    })
    expect(msgLine()).toBe('mc_ms_am_saved')
  })

  test("a refusal puts the old level back and says the server's words", async () => {
    await open('automod')
    await flush()
    reply = () => ({ ok: false, error: 'error', message: 'twitch refused' })
    key('4')
    await flush()
    expect(body().querySelector('.hs-ms-on').textContent).toBe('1')
    expect(msgLine()).toBe('twitch refused')
  })

  test('advanced folds out the 8 categories; a category sets its own key', async () => {
    await open('automod')
    await flush()
    expect(win.document.querySelectorAll('.hs-ms-row').length).toBe(1)
    key('a')
    expect(win.document.querySelectorAll('.hs-ms-row').length).toBe(9)
    key('j')
    key('2')
    await flush()
    expect(sent.at(-1)).toMatchObject({ op: 'automod_set', key: 'disability', level: 2 })
  })

  test('numbers set levels here, not cells', async () => {
    await open('automod')
    await flush()
    key('2')
    expect(activeCell()).toBe('mc_ms_cell_automod')
  })
})

suite('mod suite panel — chatters', () => {
  test('lists as text and filters by login or name; the filter owns its keys', async () => {
    await open('chatters')
    await flush()
    expect(rows()).toEqual(['Alice', 'Bobby', '<b>x</b>'])
    expect(body().querySelector('b')).toBeNull()
    key('/')
    const f = win.document.querySelector('.hs-ms-input')
    f.value = 'BOB'
    f.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(rows()).toEqual(['Bobby'])
    expect(win.document.querySelector('.hs-ms-count').textContent).toBe('mc_ms_ch_count_of:1,3')
    key('s', f) // typing in the field never fires a panel key
    key('Escape', f)
    expect(win.document.querySelector('.hs-ms')).not.toBeNull()
    expect(rows().length).toBe(3)
  })

  test('a partial list says so', async () => {
    reply = () => ({ ok: true, data: { total: 900, chatters: [{ user_login: 'a', user_name: 'A' }] } })
    await open('chatters')
    await flush()
    expect(win.document.querySelector('.hs-ms-count').textContent).toBe('mc_ms_ch_count_part:1,900')
  })

  test('msChattersVisible is a case-insensitive substring', () => {
    const l = [
      { user_login: 'alice', user_name: 'Alice' },
      { user_login: 'bob', user_name: 'Bobby' },
    ]
    expect(api.msChattersVisible(l, 'ALI').length).toBe(1)
    expect(api.msChattersVisible(l, '  ').length).toBe(2)
  })
})

suite('warn + shoutout', () => {
  const field = () => win.document.querySelector('.hs-ms-input')

  test('the warn prompt sends the reason on enter', async () => {
    const p = api.msWarnPrompt('somechannel', 'troll')
    expect(win.document.querySelector('.hs-pane-panel')).not.toBeNull()
    field().value = '  stop that  '
    key('Enter', field())
    const res = await p
    expect(res.ok).toBe(true)
    expect(sent.at(-1)).toEqual({
      type: 'mod_suite',
      channel: 'somechannel',
      op: 'warn',
      user: 'troll',
      reason: 'stop that',
    })
    expect(toasts.at(-1)).toEqual(['mc_ms_warned:troll', 'success'])
  })

  test('an empty reason is not sent; esc cancels with nothing sent', async () => {
    const p = api.msWarnPrompt('somechannel', 'troll')
    key('Enter', field())
    expect(sent).toEqual([])
    expect(win.document.querySelector('.hs-pane-panel')).not.toBeNull()
    key('Escape')
    expect(await p).toBeNull()
    expect(sent).toEqual([])
  })

  test('shoutout posts the login; a cooldown shows twitch’s own words', async () => {
    await api.msShoutout('somechannel', 'friend')
    expect(sent.at(-1)).toEqual({ type: 'mod_suite', channel: 'somechannel', op: 'shoutout', user: 'friend' })
    expect(toasts.at(-1)).toEqual(['mc_ms_shouted:friend', 'success'])
    reply = () => ({ ok: false, error: 'rate_limited', message: 'wait 2 minutes' })
    await api.msShoutout('somechannel', 'friend')
    expect(toasts.at(-1)).toEqual(['wait 2 minutes', 'error'])
  })

  test('a missing scope on a slash call toasts and opens the panel with the relink', async () => {
    reply = () => ({ ok: false, error: 'relink_required', message: '' })
    await api.msShoutout('somechannel', 'friend')
    await flush()
    expect(toasts.at(-1)).toEqual(['mc_ms_need_perm', 'error'])
    expect(win.document.querySelector('.hs-ms')).not.toBeNull()
  })

  test('error code → view', () => {
    expect(api.msViewFor({ error: 'relink_required' })).toBe('perm')
    expect(api.msViewFor({ error: 'not_moderator' })).toBe('notmod')
    expect(api.msViewFor({ error: 'auth_required' })).toBe('auth')
    expect(api.msViewFor({ error: 'rate_limited' })).toBeNull()
  })
})

describe('mod suite wiring', () => {
  const FIVE = ['modtools', 'shield', 'warn', 'shoutout', 'unbanrequests']

  test('the five rows are on both surfaces, mod-gated; so aliases shoutout', () => {
    for (const c of FIVE) {
      const row = SLASH_REGISTRY.find((r) => r.cmd === c)
      expect(row, c).toMatchObject({ on: 'both', needs: 'mod', does: 'twitch' })
      expect(slashCommandsFor('ext').some((r) => r.cmd === c)).toBe(true)
    }
    expect(slashAliasMap('ext').so).toBe('shoutout')
  })

  test('each command has a handler branch, behind the one gate', () => {
    for (const c of ['modtools', 'unbanrequests', 'shield', 'warn', 'shoutout']) expect(INPUT).toContain(`'${c}'`)
    const at = INPUT.indexOf('const _msGate = async () => {')
    expect(at).toBeGreaterThan(0)
    const gate = INPUT.slice(at, INPUT.indexOf('\n  }\n', at))
    expect(gate).toContain('return _notLoggedIn()')
    expect(gate).toContain('mc_ms_no_channel')
    expect(gate).toContain('isModFor(login)')
    expect(INPUT).toContain("openModSuite(login, cmd === 'modtools' ? 'shield' : 'unban')")
    expect(INPUT).toContain("msCall(login, 'shield_set', { active: on })")
  })

  test('the toolbar button exists, is twitch-only, and is off by default', () => {
    expect(TOOLBAR).toMatch(/mod_tools: \{[^}]*twitchOnly: true/)
    expect(TOOLBAR).toContain("openModSuite(channel, 'shield')")
    const def = SETTINGS.find((s) => s.key === 'hs_mod_toolbar_buttons')
    expect(def.default).toEqual([])
    const opt = def.options.find((o) => o.value === 'mod_tools')
    expect(EN[opt.labelKey]).toBeDefined()
  })

  test('the row menu gets mod tools + warn for twitch rows only', () => {
    expect(INPUT).toMatch(/if \(!isKick && !isYt\) \{\s*mod\.push\(\{ label: 'mod tools'/)
    expect(INPUT).toContain("label: 'warn', fn: () => msWarnPrompt(modCh, msgLogin)")
  })

  test('the background maps each op to its route with the bearer, and each status to a code', () => {
    const at = BG.indexOf("message.type === 'mod_suite'")
    const h = BG.slice(at, BG.indexOf("message.type === 'resolve_twitch_id'"))
    for (const r of [
      'shield',
      'warn',
      'shoutout',
      'unban-requests/resolve',
      'unban-requests',
      'automod-settings',
      'chatters',
    ])
      expect(h).toContain(r)
    for (const c of ["'relink_required'", "'auth_required'", "'not_moderator'", "'rate_limited'", "'gone'"])
      expect(h).toContain(c)
    expect(h).toContain("'PUT'")
    expect(h).toContain("credentials: 'omit'")
    expect(h).toContain('Bearer')
    expect(h).toContain('slice(0, 500)')
  })

  test('every mc_ms key the code uses exists in every locale', () => {
    const used = new Set()
    for (const src of [PANEL, INPUT, TOOLBAR])
      for (const m of src.matchAll(/\bt\(\s*`?'?(mc_ms_[a-z_]*[a-z])['`,)]/g)) used.add(m[1])
    for (const c of [
      'disability',
      'aggression',
      'sexuality_sex_or_gender',
      'misogyny',
      'bullying',
      'swearing',
      'race_ethnicity_or_religion',
      'sex_based_terms',
    ])
      used.add(`mc_ms_cat_${c}`)
    for (const c of ['shield', 'unban', 'automod', 'chatters']) used.add(`mc_ms_cell_${c}`).add(`mc_ms_keys_${c}`)
    for (const s of ['pending', 'approved', 'denied']) used.add(`mc_ms_st_${s}`)
    for (const loc of readdirSync(join(ROOT, 'src', '_locales'))) {
      const m = JSON.parse(read('src', '_locales', loc, 'messages.json'))
      expect(
        [...used].filter((k) => !m[k]),
        loc,
      ).toEqual([])
    }
  })
})
