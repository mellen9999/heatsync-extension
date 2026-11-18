/**
 * Three ways a setting took a value it should not have, found by driving every non-switch
 * control, the import and the slash commands on the real ui (e2e s28, 11-17):
 *  - an imported file with fontSize "huge" or a volume of "loud" was stored as it came and
 *    the page said "settings imported"
 *  - "/set mentionSoundVolume 40", the number on the slider, stored 1 (full volume) and
 *    answered "= 40"
 *  - "reset all" emptied the hide/highlight rules, a list the user built, while mutes,
 *    blocks and saved tabs stayed
 *
 * Runs the real _importFit, the real runSetCommand and the real resetSettingsToDefaults
 * against the real registry.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coerceSettingValue, SETTINGS, validateSettingValue } from '../src/lib/settings-schema.js'
import { mainSource } from './main-src.js'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const fnOf = (src, name) => {
  const a = src.indexOf(`function ${name}(`)
  const b = src.indexOf('\n}\n', a)
  if (a < 0 || b < 0) throw new Error(`carve: ${name}`)
  return src.slice(a, b + 3)
}
const def = (key) => SETTINGS.find((d) => d.key === key)

describe('an imported value has to fit its setting', () => {
  const _importFit = new Function(
    'SETTINGS',
    'coerceSettingValue',
    'validateSettingValue',
    `${fnOf(read('src', 'multichat', 'settings-ui.js'), '_importFit')}\nreturn _importFit`,
  )(SETTINGS, coerceSettingValue, validateSettingValue)

  test('wrong kinds of value are left out and counted, the rest goes in', () => {
    const { out, left } = _importFit(
      {
        fontSize: 'huge',
        mentionSoundVolume: 'loud',
        hiddenTabs: 'nope',
        hideBots: 'nope',
        mentionSound: 'blip',
        timestamps: true,
      },
      true,
    )
    expect(left).toBe(4)
    expect(out).toEqual({ mentionSound: 'blip', timestamps: true })
  })

  test('what an export holds comes back as it was', () => {
    const bag = {}
    for (const d of SETTINGS) if (d.scope === 'sync') bag[d.key] = d.default
    const { out, left } = _importFit(bag, true)
    expect(left).toBe(0)
    expect(out).toEqual(bag)
  })

  test('a key the registry does not know passes through: the store has its own sanitizer', () => {
    expect(_importFit({ hs_panel_width_px: 412, someFutureThing: [1, 2] }, true)).toEqual({
      out: { hs_panel_width_px: 412, someFutureThing: [1, 2] },
      left: 0,
    })
  })

  test('local settings and the mirrored rules are checked under their own keys', () => {
    const local = SETTINGS.find((d) => d.scope === 'local' && d.type === 'bool')
    const rules = def('chatFilterRules')
    const { out, left } = _importFit({ [local.key]: 'yes', [rules.mirrorKey]: { not: 'text' }, hs_other: 1 }, false)
    expect(left).toBe(2)
    expect(out).toEqual({ hs_other: 1 })
    expect(_importFit({ [rules.mirrorKey]: '[]' }, false)).toEqual({ out: { [rules.mirrorKey]: '[]' }, left: 0 })
  })

  test('the import uses it for both bags, says how many were left out, and refuses a file with nothing usable', () => {
    const src = fnOf(read('src', 'multichat', 'settings-ui.js'), '_importAllSettings')
    expect(src).toMatch(/_importFit\(ui, true\)/)
    expect(src).toMatch(/_importFit\(safeLocal, false\)/)
    expect(src).toMatch(/if \(!writes\.length\) \{\s*showToast\(t\('mc_settingsui_not_heatsync_file'\), 'error'\)/)
    expect(src).toMatch(/left \? t\('mc_settingsui_import_partial', \[String\(left\)\]\)/)
  })
})

describe('/set speaks the numbers the settings page shows', () => {
  const SRC = read('src', 'multichat', 'set-command.js')
  const run = async (rest) => {
    const stored = {}
    const toasts = []
    const g = {
      SETTINGS,
      t: (k, subs) => `${k}${subs ? `:${subs.join(',')}` : ''}`,
      showToast: (m, kind) => toasts.push([m, kind]),
      clearInput: () => {},
      // the real setter's rule: coerce, validate, store
      setSetting: (key, value) => {
        const v = coerceSettingValue(def(key), value)
        if (v === undefined || !validateSettingValue(def(key), v)) return false
        stored[key] = v
        return true
      },
      getSetting: (key) => stored[key],
    }
    new Function(...Object.keys(g), `${fnOf(SRC, 'runSetCommand')}\nreturn runSetCommand`)(...Object.values(g))(
      rest,
      {},
    )
    return { stored, toast: toasts.at(-1) }
  }

  test('40 on a volume is 40 on the slider: stored 0.4, answered 40', async () => {
    const r = await run('mentionSoundVolume 40')
    expect(r.stored.mentionSoundVolume).toBeCloseTo(0.4, 10)
    expect(r.toast).toEqual(['mc_input_set_done:mentionSoundVolume,40', 'success'])
  })

  test('a number off the slider is refused with the slider range, nothing stored', async () => {
    for (const typed of ['140', '-5', 'loud']) {
      const r = await run(`mentionSoundVolume ${typed}`)
      expect(r.stored).toEqual({})
      expect(r.toast).toEqual(['mc_input_set_invalid:mentionSoundVolume · 0-100', 'error'])
    }
  })

  test('the ends of the slider are in', async () => {
    expect((await run('mentionSoundVolume 0')).stored.mentionSoundVolume).toBe(0)
    expect((await run('mentionSoundVolume 100')).stored.mentionSoundVolume).toBe(1)
  })

  test('the answer is what was stored, for the other kinds too', async () => {
    expect((await run('timestamps off')).toast).toEqual(['mc_input_set_done:timestamps,false', 'success'])
    expect((await run('mentionSound knock')).toast).toEqual(['mc_input_set_done:mentionSound,knock', 'success'])
    expect((await run('mentionSound gong')).toast[1]).toBe('error')
  })

  test('the composer hands /set to it', () => {
    expect(read('src', 'multichat', 'input.js')).toMatch(
      /if \(cmd === 'set'\) \{\s*runSetCommand\(rest, input\)\s*return true/,
    )
  })
})

describe('reset keeps what the user built', () => {
  const reset = (cat) => {
    const set = []
    new Function(
      'SETTINGS',
      'setSetting',
      'renderSettingsTab',
      `${fnOf(mainSource(), 'resetSettingsToDefaults')}\nreturn resetSettingsToDefaults`,
    )(
      SETTINGS,
      (k) => set.push(k),
      () => {},
    )(cat)
    return set
  }

  test('reset all leaves the hide/highlight rules and the open tab alone, and resets preferences', () => {
    const set = reset()
    expect(set).not.toContain('chatFilterRules')
    expect(set).not.toContain('activeTab')
    expect(set).toContain('hideBots')
    expect(set).toContain('mentionSoundVolume')
  })

  test('the filters page reset does the same', () => {
    const set = reset('filters')
    expect(set).not.toContain('chatFilterRules')
    expect(set.length).toBeGreaterThan(0)
  })

  test('content-warning switches do reset: hidden is their default, and switching off needs no age check', () => {
    expect(reset('filters')).toContain('viewer_show_sexual')
  })
})
