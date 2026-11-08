import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { escapeHtml } from '../src/lib/utils.js'

/**
 * The filter-rules editor (filter-rules-ui.js): edit a rule in place, plain type
 * names with a one-line example, and the live "matches n of the last 200
 * messages" count. The editor runs for real — the shipped source, the real rule
 * engine and the real english strings — against a happy-dom panel; only the
 * rest of the overlay (storage, tabs, the sound engine) is stubbed.
 */
const ROOT = join(import.meta.dir, '..')
const dir = join(ROOT, 'src', 'multichat')
const read = (f) => readFileSync(join(dir, f), 'utf8')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
const ENGINE = read('filter-rules.js').replace(/^export \{[^}]*\}\s*$/m, '')
const SOUND_UI = read('sound-ui.js')
const EDITOR = read('filter-rules-ui.js')

// the english string for a key, $PLACEHOLDERS$ filled from the substitutions
function t(key, subs = []) {
  const m = EN[key]
  if (!m) throw new Error(`missing en key ${key}`)
  let out = m.message
  for (const [name, p] of Object.entries(m.placeholders || {})) {
    out = out.replace(new RegExp(`\\$${name}\\$`, 'gi'), subs[Number(p.content.slice(1)) - 1] ?? '')
  }
  return out
}

let win
let store
let toasts
let rows // what the live count tries the rule on
let root
let ui

function boot() {
  const d = win.document
  root = d.createElement('div')
  d.body.appendChild(root)
  const g = {
    document: d,
    window: win,
    t,
    escapeHtml,
    showToast: (m, kind) => toasts.push([m, kind]),
    getSetting: (k) => store[k],
    saveUiSetting: (k, v) => {
      store[k] = v
    },
    renderMessages: () => {},
    currentTab: 'settings',
    prevTab: 'live',
    config: { channels: [{ id: 'c1', twitch: 'somechan' }] },
    fairMerge: (x) => x,
    mergedTabSources: () => rows,
    isSelf: (m) => !!m.self,
    getChannelById: () => null,
    _setCollapsed: new Set(),
    cleanup: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) },
    hsXButtonHtml: (cls, _label, attrs) => `<button class="${cls}" ${attrs}>x</button>`,
    SFX_CUSTOM: 'custom',
    SFX_PRESETS: { ping: [], blip: [], knock: [], chime: [] },
    mentionSoundVolume: 0.3,
    sfxRemove: () => {},
    sfxSave: async () => true,
    sfxRuleKey: (id) => `hs_sfx_rule_${id}`,
    renderSettingsTab: () => {
      root.innerHTML = ui._renderFilterRulesGroup()
      ui.frBindForm(root)
    },
    // settings-ui routes every [data-fr-action] click to the editor; so does this panel
    routeClicks: (el) => {
      el.addEventListener('click', (e) => {
        const frEl = e.target.closest('[data-fr-action]')
        if (frEl) ui._handleFilterRuleAction(frEl, el)
      })
    },
  }
  ui = new Function(
    ...Object.keys(g),
    `${ENGINE}\n${SOUND_UI}\n${EDITOR}
    return {
      compileFilterRules, evaluateFilterRules, previewFilterRule,
      _renderFilterRulesGroup, _handleFilterRuleAction, frBindForm, frBuildRule, frTypeLabel, frTypeHint,
      frPreviewFor,
      get editId() { return _frEditId },
    }`,
  )(...Object.values(g))
  g.routeClicks(root)
  g.renderSettingsTab()
}

const A = {
  id: 'a',
  enabled: true,
  scope: 'all',
  match: { type: 'keyword', value: 'alpha', caseSensitive: false },
  action: 'highlight',
  color: '#ff0000',
  sound: 'ping',
  soundVolume: 40,
  notify: true,
}
const B = {
  id: 'b',
  enabled: false,
  scope: 'all',
  match: { type: 'user', value: 'nightbot', caseSensitive: false },
  action: 'hide',
}
const C = {
  id: 'c',
  enabled: true,
  scope: 'c1',
  match: { type: 'regex', value: '^!(play|skip)', caseSensitive: true },
  action: 'highlight',
  color: '#00ff00',
}
const rulesNow = () => JSON.parse(store.chatFilterRules)
const btn = (action, id) => root.querySelector(`[data-fr-action="${action}"]${id ? `[data-fr-id="${id}"]` : ''}`)
const field = (n) => root.querySelector(`[data-fr-field="${n}"]`)
const setField = (n, v) => {
  const el = field(n)
  if (el.type === 'checkbox') el.checked = v
  else el.value = v
}
const repaint = () => {
  root.innerHTML = ui._renderFilterRulesGroup()
  ui.frBindForm(root)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  win = new Window({ url: 'https://example.test/' })
  store = { chatFilterRules: JSON.stringify([A, B, C]) }
  toasts = []
  rows = []
  boot()
})
afterEach(() => win.close())

describe('edit in place', () => {
  test('every row has an edit button; clicking it turns that row into the form, prefilled', () => {
    expect(root.querySelectorAll('[data-fr-action="edit"]').length).toBe(3)
    ui._handleFilterRuleAction(btn('edit', 'a'))
    const forms = root.querySelectorAll('.hs-mc-fr-addform')
    expect(forms.length).toBe(1) // the add form waits while a rule is open
    expect(forms[0].dataset.frEdit).toBe('a')
    expect(root.querySelector('[data-fr-row="a"]')).toBeNull() // its row is the form now
    expect(root.querySelector('[data-fr-row="b"]')).not.toBeNull()
    expect(field('type').value).toBe('keyword')
    expect(field('value').value).toBe('alpha')
    expect(field('action').value).toBe('highlight')
    expect(field('color').value).toBe('#ff0000')
    expect(field('sound').value).toBe('ping')
    expect(field('vol').value).toBe('40')
    expect(field('notify').checked).toBe(true)
    expect(field('scope').value).toBe('all')
    expect(btn('save')).not.toBeNull()
    expect(btn('cancel')).not.toBeNull()
    expect(btn('add')).toBeNull()
  })

  test('the form sits where the row was', () => {
    ui._handleFilterRuleAction(btn('edit', 'b'))
    const order = [...root.querySelectorAll('[data-fr-row], .hs-mc-fr-addform')].map(
      (e) => e.dataset.frRow || `form:${e.dataset.frEdit}`,
    )
    expect(order).toEqual(['a', 'form:b', 'c'])
  })

  test('save replaces the rule: same id, same place, same on/off state', () => {
    ui._handleFilterRuleAction(btn('edit', 'b'))
    setField('type', 'keyword')
    setField('value', 'spam')
    setField('scope', 'c1')
    ui._handleFilterRuleAction(btn('save'))
    const list = rulesNow()
    expect(list.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(list[1]).toEqual({
      id: 'b',
      enabled: false, // an edit never flips the switch
      scope: 'c1',
      match: { type: 'keyword', value: 'spam', caseSensitive: false },
      action: 'hide',
    })
    expect(list[0]).toEqual(A) // the others are untouched
    expect(list[2]).toEqual(C)
    expect(ui.editId).toBeNull()
    expect(root.querySelector('[data-fr-row="b"]')).not.toBeNull() // back to a row
    expect(root.querySelectorAll('.hs-mc-fr-addform').length).toBe(1) // the add form is back
    expect(root.querySelector('.hs-mc-fr-addform').dataset.frEdit).toBeUndefined()
  })

  test('the engine uses the saved edit, not the old rule', () => {
    ui._handleFilterRuleAction(btn('edit', 'a'))
    setField('value', 'omega')
    ui._handleFilterRuleAction(btn('save'))
    expect(ui.evaluateFilterRules({ text: 'omega', user: 'x', platform: 'twitch' }, null).highlight).toBe('#ff0000')
    expect(ui.evaluateFilterRules({ text: 'alpha', user: 'x', platform: 'twitch' }, null).highlight).toBe(null)
  })

  test('cancel puts the row back and writes nothing', () => {
    const before = store.chatFilterRules
    ui._handleFilterRuleAction(btn('edit', 'c'))
    setField('value', 'something else')
    ui._handleFilterRuleAction(btn('cancel'))
    expect(store.chatFilterRules).toBe(before)
    expect(ui.editId).toBeNull()
    expect(root.querySelector('[data-fr-row="c"]')).not.toBeNull()
    expect(root.querySelectorAll('.hs-mc-fr-addform').length).toBe(1)
  })

  test('an empty value is refused with a toast and the rule stays as it was', () => {
    const before = store.chatFilterRules
    ui._handleFilterRuleAction(btn('edit', 'a'))
    setField('value', '   ')
    ui._handleFilterRuleAction(btn('save'))
    expect(store.chatFilterRules).toBe(before)
    expect(toasts.length).toBe(1)
    expect(toasts[0][1]).toBe('error')
    expect(ui.editId).toBe('a') // still open, nothing lost
  })

  test('a bad advanced expression is refused too', () => {
    const before = store.chatFilterRules
    ui._handleFilterRuleAction(btn('edit', 'a'))
    setField('type', 'expr')
    setField('value', '&& &&')
    ui._handleFilterRuleAction(btn('save'))
    expect(store.chatFilterRules).toBe(before)
    expect(toasts[0][1]).toBe('error')
  })

  test('switching a highlight to hide drops its colour, sound and notify', () => {
    ui._handleFilterRuleAction(btn('edit', 'a'))
    setField('action', 'hide')
    ui._handleFilterRuleAction(btn('save'))
    const saved = rulesNow()[0]
    expect(saved.action).toBe('hide')
    for (const k of ['color', 'sound', 'soundVolume', 'notify']) expect(k in saved).toBe(false)
  })

  test('deleting the rule that is open closes the form', () => {
    ui._handleFilterRuleAction(btn('edit', 'a'))
    // the delete button of an open rule is not drawn; the same action arrives from another device's list
    const stray = win.document.createElement('button')
    stray.dataset.frAction = 'delete'
    stray.dataset.frId = 'a'
    ui._handleFilterRuleAction(stray)
    expect(rulesNow().map((r) => r.id)).toEqual(['b', 'c'])
    expect(ui.editId).toBeNull()
    expect(root.querySelector('[data-fr-edit]')).toBeNull()
  })

  test('a half-typed edit survives a repaint of the panel', () => {
    ui._handleFilterRuleAction(btn('edit', 'a'))
    setField('value', 'half typed')
    field('value').dispatchEvent(new win.Event('input', { bubbles: true }))
    repaint()
    expect(field('value').value).toBe('half typed')
    expect(root.querySelector('[data-fr-edit]').dataset.frEdit).toBe('a')
  })

  test('enter saves an open edit, escape cancels it', () => {
    ui._handleFilterRuleAction(btn('edit', 'a'))
    setField('value', 'via enter')
    field('value').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(rulesNow()[0].match.value).toBe('via enter')
    ui._handleFilterRuleAction(btn('edit', 'a'))
    setField('value', 'will not stick')
    field('value').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(rulesNow()[0].match.value).toBe('via enter')
    expect(ui.editId).toBeNull()
  })

  test('adding a rule still works and appends', () => {
    setField('value', 'brand new')
    ui._handleFilterRuleAction(btn('add'))
    const list = rulesNow()
    expect(list.length).toBe(4)
    expect(list[3].match.value).toBe('brand new')
    expect(list[3].enabled).toBe(true)
    expect(list.slice(0, 3).map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  test('the notify box is saved on a new highlight rule', () => {
    setField('value', 'ping me')
    setField('notify', true)
    ui._handleFilterRuleAction(btn('add'))
    expect(rulesNow()[3].notify).toBe(true)
  })
})

describe('plain type names and hints', () => {
  const JARGON = /^(kw|rx|expr|hl|msgtype|regex|keyword)$/i

  test('the type picker reads in plain words, none of the old short codes', () => {
    const labels = [...field('type').querySelectorAll('option')].map((o) => o.textContent)
    expect(labels).toEqual(['word', 'pattern', 'user', 'badge', 'kind', 'advanced'])
    for (const l of labels) expect(JARGON.test(l)).toBe(false)
  })

  test('a rule row names its type in plain words', () => {
    const row = root.querySelector('[data-fr-row="a"]').textContent
    expect(row).toContain('word')
    expect(row).toContain('alpha')
    expect(root.querySelector('[data-fr-row="c"]').textContent).toContain('pattern')
  })

  test('a one-line example sits under the input and follows the type', () => {
    const hint = () => root.querySelector('[data-fr-hint]').textContent
    expect(hint()).toBe(ui.frTypeHint('keyword'))
    expect(hint()).toMatch(/gg/)
    setField('type', 'regex')
    field('type').dispatchEvent(new win.Event('change', { bubbles: true }))
    expect(hint()).toBe(ui.frTypeHint('regex'))
    expect(hint()).toMatch(/\^!\(play\|skip\)/)
    for (const ty of ['keyword', 'regex', 'user', 'badge', 'msgtype', 'expr']) {
      expect(ui.frTypeHint(ty).length, ty).toBeGreaterThan(8)
      expect(ui.frTypeLabel(ty).length, ty).toBeGreaterThan(2)
    }
  })

  test('an edit form shows the hint of the rule being edited', () => {
    ui._handleFilterRuleAction(btn('edit', 'c'))
    expect(root.querySelector('[data-fr-hint]').textContent).toBe(ui.frTypeHint('regex'))
  })
})

describe('live match count', () => {
  const msg = (text, extra = {}) => ({ text, user: 'someone', platform: 'twitch', badges: '', ...extra })

  test('previewFilterRule counts hits among the newest 200 chat rows', () => {
    const msgs = []
    for (let i = 0; i < 250; i++) msgs.push(msg(i < 50 ? 'gg old' : i % 2 ? 'gg' : 'hello'))
    const res = ui.previewFilterRule(
      { scope: 'all', match: { type: 'keyword', value: 'gg' }, action: 'highlight' },
      msgs,
    )
    expect(res.ok).toBe(true)
    expect(res.total).toBe(200) // the newest 200: the 50 oldest rows are out
    expect(res.hits).toBe(100)
  })

  test('system rows and rows without text are not counted', () => {
    const res = ui.previewFilterRule({ match: { type: 'keyword', value: 'gg' }, action: 'hide' }, [
      msg('gg'),
      { type: 'notice', text: 'gg' },
      { user: 'x' },
      null,
      msg('nope'),
    ])
    expect(res).toEqual({ ok: true, hits: 1, total: 2 })
  })

  test('a rule that would not compile reports it instead of counting', () => {
    expect(ui.previewFilterRule({ match: { type: 'expr', value: '&& &&' }, action: 'hide' }, [msg('x')]).ok).toBe(false)
    expect(ui.previewFilterRule({ match: { type: 'keyword', value: '' }, action: 'hide' }, [msg('x')]).ok).toBe(false)
  })

  test('uses the real matcher: case, whole words, users, kinds', () => {
    const rows3 = [msg('GG wp'), msg('aggro'), msg('hi', { user: 'nightbot' }), msg('hey', { isFirstMsg: true })]
    const n = (type, value, cs) =>
      ui.previewFilterRule({ match: { type, value, caseSensitive: !!cs }, action: 'highlight' }, rows3).hits
    expect(n('keyword', 'gg')).toBe(1) // not inside "aggro"
    expect(n('keyword', 'gg', true)).toBe(0) // case matters when asked
    expect(n('user', 'nightbot')).toBe(1)
    expect(n('msgtype', 'first-message')).toBe(1)
  })

  test('the form shows the count after a short pause', async () => {
    rows = [msg('gg'), msg('hello'), msg('gg again'), msg('x')]
    setField('value', 'gg')
    field('value').dispatchEvent(new win.Event('input', { bubbles: true }))
    expect(root.querySelector('[data-fr-preview]').textContent).toBe('') // debounced, not per keystroke
    await wait(330)
    expect(root.querySelector('[data-fr-preview]').textContent).toBe('matches 2 of the last 4 messages')
  })

  test('typing fast runs the count once, on the last value', async () => {
    rows = [msg('aa'), msg('bb')]
    for (const v of ['a', 'aa', 'bb']) {
      setField('value', v)
      field('value').dispatchEvent(new win.Event('input', { bubbles: true }))
    }
    await wait(330)
    expect(root.querySelector('[data-fr-preview]').textContent).toBe('matches 1 of the last 2 messages')
  })

  test('says so when nothing matches, when there is nothing to try it on, and when the rule is broken', () => {
    const d = { type: 'keyword', value: 'zzz', action: 'highlight', scope: 'all', cs: false }
    expect(ui.frPreviewFor(d, [msg('a'), msg('b'), msg('c')]).text).toBe('matches none of the last 3 messages')
    expect(ui.frPreviewFor(d, []).text).toBe('no messages here yet to try it on')
    expect(ui.frPreviewFor({ ...d, type: 'expr', value: '&& &&' }, [msg('a')]).text).toBe(
      "this rule doesn't work yet. check what you typed",
    )
    expect(ui.frPreviewFor({ ...d, value: '  ' }, [msg('a')])).toBeNull() // nothing typed: no line at all
  })

  test('an open edit shows its count straight away', () => {
    rows = [msg('alpha one'), msg('beta'), msg('alpha two')]
    ui._handleFilterRuleAction(btn('edit', 'a'))
    expect(root.querySelector('[data-fr-preview]').textContent).toBe('matches 2 of the last 3 messages')
  })

  test('your own messages are not counted (a rule never touches them)', async () => {
    rows = [msg('gg'), msg('gg', { self: true }), msg('other')]
    setField('value', 'gg')
    field('value').dispatchEvent(new win.Event('input', { bubbles: true }))
    await wait(330)
    expect(root.querySelector('[data-fr-preview]').textContent).toBe('matches 1 of the last 2 messages')
  })
})
