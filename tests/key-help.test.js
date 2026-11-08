/**
 * The in-app key help says every key the chat binds: alt+1..9, alt+[ / alt+],
 * alt+r, row mode and its own keys, and the vi <Space> r leader — in the
 * viewer's language. It used to list only the settings pane's keys, so the keys
 * that work everywhere were learnable only by accident.
 *
 * The help pane renderer is sliced out of settings-ui.js and run for real. A
 * second check reads the alt-key handler in main-overlay.js and fails if it binds
 * a key the help does not name, so a new shortcut can't ship undocumented.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './en-t.js'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const UI = read('src', 'multichat', 'settings-ui.js')
const SLICE = UI.slice(UI.indexOf('const _SET_HELP_KEYS = ['), UI.indexOf('// ─── settings keyboard nav'))

let api

beforeEach(() => {
  api = new Function(
    't',
    'escapeHtml',
    '_setHelpActionRows',
    'slashHelpText',
    'slashDesc',
    `let viModeEnabled = false
     ${SLICE}
     return { render: _renderHelpPane, setVi: (v) => { viModeEnabled = v }, CHAT: _SET_HELP_CHAT, ROWS: _SET_HELP_ROWS, VIM: _SET_HELP_VIM }`,
  )(
    t,
    (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    () => [],
    () => '',
    () => '',
  )
})

// the pane as [section title, [key, words][]] — read back out of the html it really produced
function sections(html) {
  const out = []
  const re = /<div class="hs-mc-set-help-title">([^<]*)<\/div>(?:<div class="hs-mc-set-help-grid">(.*?)<\/div>)?/g
  for (const m of html.matchAll(re)) {
    const pairs = [
      ...(m[2] || '').matchAll(/<span class="hs-mc-set-help-key">([^<]*)<\/span><span>([^<]*)<\/span>/g),
    ].map((p) => [p[1], p[2]])
    out.push([m[1], pairs])
  }
  return out
}
const section = (html, title) => sections(html).find((s) => s[0] === title)?.[1]

describe('the help pane', () => {
  test('a "chat" section names alt 1-9, alt [ ] and alt r', () => {
    expect(section(api.render(), 'chat')).toEqual([
      ['alt 1-9', 'go to that tab'],
      ['alt [ ]', 'previous / next tab'],
      ['alt r', 'row mode'],
    ])
  })

  test('a "row mode" section names the keys you use inside it', () => {
    expect(section(api.render(), 'row mode')).toEqual([
      ['j k', 'move'],
      ['g G', 'first / last'],
      ['enter', 'actions menu'],
      ['r', 'reply'],
      ['esc', 'leave'],
    ])
  })

  test('both show with vi mode off: alt combos and row mode need no vi', () => {
    api.setVi(false)
    const html = api.render()
    expect(section(html, 'chat')).toBeTruthy()
    expect(section(html, 'row mode')).toBeTruthy()
    expect(section(html, 'vi')).toBeUndefined()
  })

  test('with vi mode on, the <Space> r leader is listed in the vi section too', () => {
    api.setVi(true)
    expect(section(api.render(), 'vi')).toContainEqual(['spc r', 'row mode'])
  })

  test('the original settings keys are still there', () => {
    expect(section(api.render(), 'keys').map((k) => k[0])).toContain('?')
  })
})

describe('nothing bound is undocumented', () => {
  // the alt-key handler in main-overlay.js, as the codes it reacts to
  const overlay = read('src', 'multichat', 'main-overlay.js')
  const start = overlay.indexOf('if (!e.altKey || e.ctrlKey || e.metaKey) return')
  const handler = overlay.slice(start, overlay.indexOf('{ signal: mcSignal, capture: true }', start))
  const codes = new Set([
    ...[...handler.matchAll(/e\.code === '(\w+)'/g)].map((m) => m[1]),
    ...[...handler.matchAll(/\/\^(Digit)\[1-9\]\$\//g)].map((m) => m[1]),
  ])
  // what each bound code is called in the help
  const HELP_FOR = { KeyR: 'alt r', Digit: 'alt 1-9', BracketRight: 'alt [ ]', BracketLeft: 'alt [ ]' }

  test('the handler binds the keys we think it does (a new one fails here until it is listed)', () => {
    expect([...codes].sort()).toEqual(Object.keys(HELP_FOR).sort())
  })

  test('it listens in the CAPTURE phase: the composer stops propagation of every key, so a bubbling listener never hears alt+key typed there', () => {
    expect(read('src', 'multichat', 'input.js')).toContain('e.stopPropagation()\n\n  // The whole body is wrapped')
    expect(handler).toBeTruthy()
    expect(overlay.slice(start, start + handler.length + 80)).toContain('{ signal: mcSignal, capture: true }')
  })

  test('every key it binds is in the help', () => {
    const listed = api.CHAT.map((k) => k[0])
    for (const code of codes) expect(listed, code).toContain(HELP_FOR[code])
  })

  test('the vi leader and the alt combo open the SAME mode', () => {
    expect(read('src', 'multichat', 'row-mode.js')).toContain("registerOverlayKey('r', () => enterRowMode())")
    expect(handler).toContain('toggleRowMode()')
  })

  test("vi mode's cheat sheet carries the row mode line", () => {
    expect(read('src', 'content', 'vi-mode.js')).toContain("hsViT('cs_vi_cheatsheet_rows')")
  })
})

describe('in every language', () => {
  const keys = [
    'mc_set_h_chat',
    'mc_set_h_nth_tab',
    'mc_set_h_tab_cycle',
    'mc_set_h_rows',
    'mc_set_h_row_menu',
    'mc_set_h_row_reply',
    'mc_set_h_row_leave',
    'cs_vi_cheatsheet_rows',
  ]
  const dirs = readdirSync(join(ROOT, 'src', '_locales'))

  test('every help string exists in all 34 catalogs', () => {
    expect(dirs.length).toBe(34)
    const used = new Set([...SLICE.matchAll(/'(mc_set_h_\w+)'/g)].map((m) => m[1]))
    for (const k of keys.filter((x) => x.startsWith('mc_'))) expect(used.has(k), k).toBe(true)
    for (const d of dirs) {
      const cat = JSON.parse(read('src', '_locales', d, 'messages.json'))
      for (const k of [...used, ...keys]) expect(cat[k]?.message, `${d}.${k}`).toBeTruthy()
    }
  })

  test('the cheat sheet line keeps its key name and layout, and is translated (not the english)', () => {
    const en = JSON.parse(read('src', '_locales', 'en', 'messages.json')).cs_vi_cheatsheet_rows.message
    expect(en).toBe('SPC r    row mode')
    for (const d of dirs.filter((x) => x !== 'en')) {
      const msg = JSON.parse(read('src', '_locales', d, 'messages.json')).cs_vi_cheatsheet_rows.message
      expect(msg.startsWith('SPC r    '), d).toBe(true)
      expect(msg, d).not.toBe(en)
    }
  })

  test('the new help words are not english copies', () => {
    const en = JSON.parse(read('src', '_locales', 'en', 'messages.json'))
    // a word that is the same in a language is fine; most of them must differ
    // "chat" is the everyday word for it in most of them (cs da de es fr ...), so it is the one exempt
    for (const k of keys.filter((x) => x !== 'mc_set_h_chat')) {
      const same = dirs.filter(
        (d) => d !== 'en' && JSON.parse(read('src', '_locales', d, 'messages.json'))[k].message === en[k].message,
      )
      expect(same.length, `${k}: ${same.join(' ')}`).toBeLessThan(8)
    }
  })
})
