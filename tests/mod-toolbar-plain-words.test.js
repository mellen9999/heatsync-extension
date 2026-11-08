/**
 * The mod hover toolbar's faces used to be "bt", "mt" and "purge": a 9-year-old (or a new mod) cannot
 * guess any of them. The faces are now plain, translated words ("words", "tools", "clear"); the
 * short glyph/duration faces (x, 1m, 10m, 1h, 24h, 7d, ⛔, ✓) stay because their tooltip and the settings
 * list spell them out. Run for real: the toolbar is built from the real catalog with a happy-dom document,
 * and the settings list is read from the real registry.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { SETTINGS } from '../src/lib/settings-schema.js'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const TOOLBAR = read('src', 'multichat', 'mod-toolbar.js')
const EN = JSON.parse(read('src', '_locales', 'en', 'messages.json'))
const CODES = readdirSync(join(ROOT, 'src', '_locales'))
const loc = (c) => JSON.parse(read('src', '_locales', c, 'messages.json'))

const FACES = { purge: 'mc_mtb_l_purge', blocked_terms: 'mc_mtb_l_bt', mod_tools: 'mc_mtb_l_mt' }

function buildBar(ids, t) {
  const win = new Window()
  const slice = TOOLBAR.slice(
    TOOLBAR.indexOf('const MOD_BUTTON_CATALOG = {'),
    TOOLBAR.indexOf('function gateModButtons'),
  )
  const make = new Function(
    'document',
    't',
    'runModAction',
    'twitchGql',
    'chrome',
    `${slice}
    modToolbarButtons = ${JSON.stringify(ids)}
    return { bar: buildModToolbarOnce(), catalog: MOD_BUTTON_CATALOG }`,
  )
  return make(
    win.document,
    t,
    () => {},
    async () => ({}),
    { storage: { onChanged: { addListener() {} } } },
  )
}

describe('mod toolbar: plain-word faces', () => {
  const ALL = Object.keys(FACES)

  test('the three opaque faces are words from the catalog, not hard-coded codes', () => {
    const t = (k) => `«${k}»`
    const { bar } = buildBar(ALL, t)
    const faces = Object.fromEntries([...bar.querySelectorAll('button')].map((b) => [b.dataset.modBtn, b.textContent]))
    for (const [id, key] of Object.entries(FACES)) expect(faces[id], id).toBe(`«${key}»`)
    expect(Object.values(faces).join(' ')).not.toMatch(/\b(bt|mt|purge)\b/)
  })

  test('the glyph and duration faces are untouched', () => {
    const t = (k) => k
    const ids = [
      'delete_message',
      'timeout_1m',
      'timeout_10m',
      'timeout_1h',
      'timeout_24h',
      'timeout_7d',
      'ban',
      'unban',
    ]
    const { bar } = buildBar(ids, t)
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'x',
      '1m',
      '10m',
      '1h',
      '24h',
      '7d',
      '⛔',
      '✓',
    ])
  })

  test('each face keeps its tooltip, so the short form always has its meaning one hover away', () => {
    const t = (k) => `«${k}»`
    const { bar, catalog } = buildBar(ALL, t)
    for (const b of bar.querySelectorAll('button')) expect(b.title).toBe(`«${catalog[b.dataset.modBtn].titleKey}»`)
  })

  test('settings lists the same three words as the faces (translated), next to their full labels', () => {
    const def = SETTINGS.find((s) => s.key === 'hs_mod_toolbar_buttons')
    for (const [id, key] of Object.entries(FACES)) {
      const o = def.options.find((x) => x.value === id)
      expect(o.tagKey, id).toBe(key)
      expect(o.tag, id).toBeUndefined()
    }
    expect(EN.mc_settings_mod_btn_purge.message).toBe('clear their messages (1 second timeout)')
    // the settings list resolves the translated word at draw time
    expect(read('src', 'multichat', 'settings-ui.js')).toContain('var mFace = o.tagKey ? t(o.tagKey) : o.tag')
  })

  test('the words exist in every language, and none is the old code', () => {
    for (const c of CODES) {
      const m = loc(c)
      for (const key of Object.values(FACES)) {
        const w = m[key]?.message
        expect(w, `${c} ${key}`).toBeTruthy()
        expect(w.length, `${c} ${key} must fit a small button`).toBeLessThanOrEqual(12)
      }
      expect(m.mc_mtb_l_purge.message.toLowerCase(), c).not.toBe('purge')
      expect(m.mc_mtb_l_bt.message.toLowerCase(), c).not.toBe('bt')
      expect(m.mc_mtb_l_mt.message.toLowerCase(), c).not.toBe('mt')
    }
  })
})
