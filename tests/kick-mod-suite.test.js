import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLASH_REGISTRY } from '../src/multichat/slash-registry.js'
import { bgSource } from './bg-src.js'

/**
 * Kick mod tools: blocked words, message filter, chatters (kick-mod-calls.js +
 * kick-mod-suite.js), the background request builder, the relay's guard, and
 * the doors that open the panel. Routes are the web.kick.com ones kick's own
 * dashboard calls; the request shapes here are what that bundle sends.
 */
const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const dir = join(ROOT, 'src', 'multichat')
const CALLS = read('src', 'multichat', 'kick-mod-calls.js')
const PANEL_SRC = [
  'x-glyph.js',
  'pane-panel.js',
  'mod-suite-calls.js',
  'mod-suite.js',
  'kick-mod-calls.js',
  'kick-mod-suite.js',
]
  .map((f) => readFileSync(join(dir, f), 'utf8'))
  .join('\n')
const PANEL_FILE = read('src', 'multichat', 'kick-mod-suite.js')
const BG = bgSource()
const CONTENT = read('chrome', 'content.js')
const INPUT = read('src', 'multichat', 'input.js')

// the request builder, carved out of the service worker the way other tests do
const carve = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to))
const BUILD_SRC = BG.slice(
  BG.indexOf('const KICK_WEB_MOD_OPS'),
  BG.indexOf('\n}\n', BG.indexOf('function kickWebModRequest(')) + 3,
)
const { KICK_WEB_MOD_OPS, kickWebModRequest } = new Function(
  `${BUILD_SRC}; return { KICK_WEB_MOD_OPS, kickWebModRequest }`,
)()

const RULES = {
  sexual_content: 1,
  hate_speech: 2,
  violence: 0,
  bullying: 3,
  drugs: 0,
  weapons: 1,
  gibberish: 0,
  spam: 1,
}

describe('background request builder', () => {
  test('reads go to the channel id on web.kick.com', () => {
    expect(kickWebModRequest('words_get', 668)).toEqual({
      method: 'GET',
      url: 'https://web.kick.com/api/v1/channels/668/chat/banned-words',
    })
    expect(kickWebModRequest('rules_get', 668).url).toBe(
      'https://web.kick.com/api/v1/channels/668/chat/moderation-rules',
    )
    expect(kickWebModRequest('chatters', 668).url).toBe('https://web.kick.com/api/v1/channels/668/chat/active-chatters')
  })

  test('a word edit is additions + removals of {word, permission}', () => {
    expect(kickWebModRequest('words_edit', 668, { add: [{ word: ' spoiler ', permission: 'PUBLIC' }] })).toEqual({
      method: 'PUT',
      url: 'https://web.kick.com/api/v1/channels/668/chat/banned-words',
      body: { additions: [{ word: 'spoiler', permission: 'PUBLIC' }], removals: [] },
    })
    const r = kickWebModRequest('words_edit', 668, { remove: [{ word: 'old', permission: 'PUBLIC', extra: 1 }] })
    expect(r.body).toEqual({ additions: [], removals: [{ word: 'old', permission: 'PUBLIC' }] })
  })

  test('an empty edit, a bad channel id or an unknown op builds nothing', () => {
    expect(kickWebModRequest('words_edit', 668, { add: [{ word: '  ' }] })).toBeNull()
    expect(kickWebModRequest('words_get', 'abc')).toBeNull()
    expect(kickWebModRequest('words_get', 0)).toBeNull()
    expect(kickWebModRequest('ban', 668)).toBeNull()
  })

  test('filter levels go as exactly the eight keys, whole numbers, in range', () => {
    const r = kickWebModRequest('rules_set', 668, { rules: { ...RULES, junk: 9 } })
    expect(r.method).toBe('PUT')
    expect(Object.keys(r.body).sort()).toEqual(Object.keys(RULES).sort())
    expect(kickWebModRequest('rules_set', 668, { rules: { ...RULES, hate_speech: 4 } })).toBeNull()
    expect(kickWebModRequest('rules_set', 668, { rules: { ...RULES, spam: 1.5 } })).toBeNull()
    const partial = { ...RULES }
    delete partial.drugs
    expect(kickWebModRequest('rules_set', 668, { rules: partial })).toBeNull()
  })

  test('the whitelist is the five ops and the handler routes them through the relay', () => {
    expect([...KICK_WEB_MOD_OPS].sort()).toEqual(['chatters', 'rules_get', 'rules_set', 'words_edit', 'words_get'])
    expect(BG).toContain('webReq = kickWebModRequest(action, channelId, message)')
    expect(BG).toContain('web: webReq,')
    // the channel id, not the chatroom id, keys these routes
    expect(BG).toContain('channelId = data?.id || null')
  })
})

describe('relay guard (the kick.com tab)', () => {
  const relay = carve(CONTENT, 'if (message.web) {', "if (message.action === 'ban') {")
  test('only GET/PUT to the three web.kick.com chat routes, and only with a bearer', () => {
    expect(relay).toContain("(w.method !== 'GET' && w.method !== 'PUT')")
    expect(relay).toContain('!message.sessionToken')
    const re = relay.match(/!\/(\^https[^\n]+\$)\/\.test/)?.[1]
    const rx = new RegExp(re.replace(/\\\//g, '/'))
    const ok = (u) => rx.test(u)
    expect(ok('https://web.kick.com/api/v1/channels/668/chat/banned-words')).toBe(true)
    expect(ok('https://web.kick.com/api/v1/channels/668/chat/moderation-rules')).toBe(true)
    expect(ok('https://web.kick.com/api/v1/channels/668/chat/active-chatters')).toBe(true)
    expect(ok('https://evil.example/api/v1/channels/668/chat/banned-words')).toBe(false)
    expect(ok('https://web.kick.com.evil.example/api/v1/channels/668/chat/banned-words')).toBe(false)
    expect(ok('https://web.kick.com/api/v1/channels/668/settings')).toBe(false)
    expect(ok('https://web.kick.com/api/v1/channels/668/chat/banned-words?x=1')).toBe(false)
  })

  test('it sends the bearer only, no cookies, and keeps 401/403/429 plain', () => {
    expect(relay).toContain("'x-app-platform': 'web'")
    expect(relay).not.toContain("credentials: 'include'")
    expect(relay).not.toContain('X-XSRF-TOKEN')
    const fn = carve(CONTENT, 'function explainKickMod(status)', '// Kick mod relay')
    const explain = new Function(`${fn}; return explainKickMod`)()
    expect(explain(401)).toContain('not a mod')
    expect(explain(403)).toContain('not a mod')
    expect(explain(429)).toContain('rate limited')
    expect(explain(503)).toContain('server error')
    expect(explain(400)).toBe('')
  })
})

describe('call readers', () => {
  const t = (k) => k
  const lib = new Function(
    't',
    'safeSendMessage',
    `${CALLS}; return { kmFail, kmWords, kmRules, kmChatters, kmChattersVisible, kmCall }`,
  )
  const make = (reply) => lib(t, async (m) => reply(m))
  const L = make(() => ({}))

  test('words: sorted, unrecognised answers are null', () => {
    expect(L.kmWords({ channel_id: 1, words: [{ word: 'b', permission: 'PUBLIC' }, { word: 'a' }] })).toEqual([
      { word: 'a', permission: 'PUBLIC' },
      { word: 'b', permission: 'PUBLIC' },
    ])
    expect(L.kmWords({ words: [] })).toEqual([])
    expect(L.kmWords({})).toBeNull()
    expect(L.kmWords({ words: [{ word: 5 }] })).toBeNull()
  })

  test('rules: all eight keys or nothing (a partial read must never be written back)', () => {
    expect(L.kmRules({ channel_id: 1, ...RULES })).toEqual(RULES)
    const { spam, ...rest } = RULES
    expect(spam).toBe(1)
    expect(L.kmRules(rest)).toBeNull()
    expect(L.kmRules({ ...RULES, violence: 7 })).toBeNull()
    expect(L.kmRules({ ...RULES, gibberish: 2 })).toBeNull()
    expect(L.kmRules(null)).toBeNull()
  })

  test('chatters: roles over plain, each person once, total kept', () => {
    const out = L.kmChatters({
      bots: [{ slug: 'bot1', username: 'Bot1' }],
      chatters: [
        { slug: 'amy', username: 'Amy' },
        { slug: 'mo', username: 'Mo' },
      ],
      moderators: [{ slug: 'mo', username: 'Mo' }],
      ogs: [],
      vips: [{ slug: 'vee', username: 'Vee' }],
      total_count: 9,
    })
    expect(out.total).toBe(9)
    expect(out.list.map((c) => `${c.login}:${c.role}`).sort()).toEqual(['amy:', 'bot1:bot', 'mo:moderator', 'vee:vip'])
    expect(L.kmChatters({})).toBeNull()
    expect(L.kmChattersVisible(out.list, 'VE').map((c) => c.login)).toEqual(['vee'])
  })

  test('errors become plain views: signed out, not a mod, anything else', () => {
    expect(L.kmFail({ error: 'kick_not_logged_in' })).toMatchObject({ view: 'auth', message: 'mc_kms_signin' })
    expect(L.kmFail({ error: 'no_kick_tab' }).view).toBe('auth')
    expect(L.kmFail({ status: 403, error: "you're not a mod" })).toMatchObject({
      view: 'notmod',
      message: 'mc_ms_not_mod',
    })
    expect(L.kmFail({ status: 401 }).view).toBe('notmod')
    expect(L.kmFail({ status: 429, error: 'kick rate limited — wait a moment' })).toMatchObject({
      view: 'error',
      message: 'kick rate limited — wait a moment',
    })
    expect(L.kmFail({})).toMatchObject({ view: 'error', message: 'mc_kms_err' })
    expect(L.kmFail({ error: 'no_channel' }).message).toBe('mc_kms_err')
  })

  test('kmCall asks the background for a kick_mod_action and unwraps data', async () => {
    const seen = []
    const C = make((m) => {
      seen.push(m)
      return { ok: true, data: { words: [] } }
    })
    expect(await C.kmCall('chan', 'words_get')).toEqual({ ok: true, data: { words: [] } })
    expect(seen[0]).toEqual({ type: 'kick_mod_action', action: 'words_get', slug: 'chan' })
    const D = make(() => ({ ok: false, status: 403, error: 'x' }))
    expect(await D.kmCall('chan', 'words_get')).toMatchObject({ ok: false, view: 'notmod' })
  })
})

describe('doors', () => {
  test('/kickmod is registered, ext-only, kick, mods', () => {
    const c = SLASH_REGISTRY.find((x) => x.cmd === 'kickmod')
    expect(c).toMatchObject({ on: 'ext', needs: 'mod', does: 'kick' })
    expect(INPUT).toContain("cmd === 'kickmod'")
    expect(INPUT).toContain('kickModCommand(_kickModSlug, input)')
    expect(PANEL_FILE).toContain('isKickModFor(slug)')
  })

  test("the row menu item opens kick's panel on a kick row, twitch's otherwise", () => {
    expect(INPUT).toContain('modToolsItem(isKick, modCh)')
    const calls = []
    const item = new Function(
      't',
      'openKickModSuite',
      'openModSuite',
      `${PANEL_FILE.slice(PANEL_FILE.indexOf('function modToolsItem'))}; return modToolsItem`,
    )(
      (k) => k,
      (...a) => calls.push(['kick', ...a]),
      (...a) => calls.push(['twitch', ...a]),
    )
    expect(item(true, 'kc').label).toBe('content_card_mod_tools')
    item(true, 'kc').fn()
    item(false, 'tc').fn()
    expect(calls).toEqual([
      ['kick', 'kc'],
      ['twitch', 'tc', 'shield'],
    ])
  })

  test('the files are in the bundle, calls before the panel', () => {
    const b = read('build.js')
    expect(b.indexOf("'kick-mod-calls.js'")).toBeGreaterThan(b.indexOf("'mod-suite.js'"))
    expect(b.indexOf("'kick-mod-suite.js'")).toBeGreaterThan(b.indexOf("'kick-mod-calls.js'"))
  })
})

// ── the panel, for real, in a happy-dom pane ────────────────────────────────
import { Window } from 'happy-dom'

const flush = () => new Promise((r) => setTimeout(r, 0))

let win
let sent
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
    `${PANEL_SRC}; return { openKickModSuite }`,
  )(
    d,
    win,
    t,
    () => {},
    async (m) => {
      sent.push(m)
      return reply(m)
    },
    'chan',
    () => {},
  )
}

const open = (cell) => api.openKickModSuite('KChan', cell)
const body = () => win.document.querySelector('.hs-ms-body')
const msgLine = () => win.document.querySelector('.hs-ms-msg').textContent
const rows = () => [...win.document.querySelectorAll('.hs-ms-row .hs-ms-text')].map((n) => n.textContent)
const key = (k, target = win.document.body) =>
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const activeCell = () => win.document.querySelector('.hs-ms-cells .hs-ms-on').textContent
const addBox = () => win.document.querySelectorAll('.hs-ms-input')[0]

beforeEach(() => {
  win = new Window()
  sent = []
  reply = (m) => {
    if (m.action === 'words_get')
      return {
        ok: true,
        data: {
          words: [
            { word: 'zeta', permission: 'PUBLIC' },
            { word: '<b>x</b>', permission: 'PUBLIC' },
          ],
        },
      }
    if (m.action === 'words_edit') return { ok: true, data: {} }
    if (m.action === 'rules_get') return { ok: true, data: { channel_id: 1, ...RULES } }
    if (m.action === 'rules_set') return { ok: true, data: {} }
    if (m.action === 'chatters')
      return {
        ok: true,
        data: {
          chatters: [{ slug: 'amy', username: 'Amy' }],
          moderators: [{ slug: 'mo', username: 'Mo' }],
          total_count: 2,
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
  globalThis.document = prevDocument
  globalThis.window = prevWindow
  win.close()
})

describe('kick mod panel — blocked words', () => {
  test('opens on words, asks kick for the list, renders words as text', async () => {
    expect(await open()).toBe(true)
    await flush()
    expect(sent[0]).toEqual({ type: 'kick_mod_action', action: 'words_get', slug: 'kchan' })
    expect(activeCell()).toBe('mc_kms_cell_words')
    expect(rows()).toEqual(['<b>x</b>', 'zeta'])
    expect(body().querySelector('b')).toBeNull()
  })

  test('enter in the box adds a word; the list changes only after kick agrees', async () => {
    await open()
    await flush()
    const box = addBox()
    box.value = '  Spoiler '
    key('Enter', box)
    await flush()
    expect(sent.at(-1)).toEqual({
      type: 'kick_mod_action',
      action: 'words_edit',
      slug: 'kchan',
      add: [{ word: 'Spoiler', permission: 'PUBLIC' }],
    })
    expect(rows()).toContain('Spoiler')
    expect(msgLine()).toBe('mc_kms_word_added:Spoiler')
    expect(box.value).toBe('')
  })

  test('a duplicate is refused without a call; a refusal leaves the list alone', async () => {
    await open()
    await flush()
    const n = sent.length
    addBox().value = 'ZETA'
    key('Enter', addBox())
    await flush()
    expect(sent.length).toBe(n)
    expect(msgLine()).toBe('mc_kms_word_exists:ZETA')
    reply = () => ({ ok: false, status: 429, error: 'kick rate limited — wait a moment' })
    addBox().value = 'fresh'
    key('Enter', addBox())
    await flush()
    expect(rows()).not.toContain('fresh')
    expect(msgLine()).toBe('kick rate limited — wait a moment')
  })

  test('d removes the picked word, sending the full word object', async () => {
    await open()
    await flush()
    key('j')
    key('d')
    await flush()
    expect(sent.at(-1)).toMatchObject({ action: 'words_edit', remove: [{ word: 'zeta', permission: 'PUBLIC' }] })
    expect(rows()).toEqual(['<b>x</b>'])
    expect(msgLine()).toBe('mc_kms_word_removed:zeta')
  })

  test('a 403 reads "not a mod", signed out reads sign in', async () => {
    reply = () => ({ ok: false, status: 403, error: 'nope' })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_ms_not_mod')
    win.document.body.innerHTML = ''
  })

  test('an unrecognised answer is "couldn\'t reach kick", never a wrong list', async () => {
    reply = () => ({ ok: true, data: { surprise: true } })
    await open()
    await flush()
    expect(body().textContent).toContain('mc_kms_err')
  })
})

describe('kick mod panel — filter and chatters', () => {
  test('filter reads eight rows; a digit key sends all eight with the one changed', async () => {
    await open('filter')
    await flush()
    expect(sent[0]).toMatchObject({ action: 'rules_get' })
    expect(win.document.querySelectorAll('.hs-ms-row').length).toBe(8)
    key('j')
    key('3')
    await flush()
    expect(sent.at(-1)).toEqual({
      type: 'kick_mod_action',
      action: 'rules_set',
      slug: 'kchan',
      rules: { ...RULES, hate_speech: 3 },
    })
    expect(msgLine()).toBe('mc_kms_filter_saved')
  })

  test('the spam toggle takes 0 or 1 only, and a failed save puts the old level back', async () => {
    await open('filter')
    await flush()
    for (let i = 0; i < 7; i++) key('j')
    key('3')
    await flush()
    expect(sent.filter((m) => m.action === 'rules_set')).toEqual([])
    reply = (m) =>
      m.action === 'rules_set' ? { ok: false, status: 429, error: 'slow down' } : { ok: true, data: RULES }
    key('0')
    await flush()
    const on = [...win.document.querySelectorAll('.hs-ms-row')].at(-1).querySelector('.hs-ms-on')
    expect(on.textContent).toBe('1')
  })

  test('chatters lists people with roles; the filter box narrows them', async () => {
    await open('chatters')
    await flush()
    expect(rows()).toEqual(['Mo', 'Amy'])
    expect(win.document.querySelector('.hs-ms-count').textContent).toBe('mc_ms_ch_count:2')
    const box = win.document.querySelectorAll('.hs-ms-input')[1]
    box.value = 'am'
    box.dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(rows()).toEqual(['Amy'])
  })

  test('h and l walk the cells', async () => {
    await open()
    await flush()
    key('l')
    await flush()
    expect(activeCell()).toBe('mc_kms_cell_filter')
    key('l')
    await flush()
    expect(activeCell()).toBe('mc_ms_cell_chatters')
    key('h')
    expect(activeCell()).toBe('mc_kms_cell_filter')
  })
})
