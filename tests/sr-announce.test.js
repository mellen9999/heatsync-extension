/**
 * Screen reader: announce all / mentions only / off.
 *
 * The message list is a polite live region, so on a busy channel a screen reader
 * reads the whole firehose. The setting hs_sr_announce picks how much it says;
 * "mentions only" silences the list and says just the lines that @ you through a
 * SEPARATE polite region (a region that is emptied and rebuilt is not reliably
 * announced, and the list is). sr-announce.js runs for real against a happy-dom
 * page; the setting itself is checked against the real schema and catalogs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { lintSettings, SETTINGS, validateSettingValue } from '../src/lib/settings-schema.js'
import { UI_SYNC_BLOCKLIST } from '../src/lib/utils.js'
import { t } from './en-t.js'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const SRC = read('src', 'multichat', 'sr-announce.js')

let win
let doc
let api
let prefs

beforeEach(() => {
  win = new Window()
  doc = win.document
  doc.body.innerHTML =
    '<div id="hs-mc-messages" role="log"></div><div id="hs-mc-sr-mentions" role="log" aria-live="polite"></div>'
  prefs = {}
  api = new Function(
    'document',
    'getSetting',
    't',
    `${SRC}; return { srMode, srLogLiveAttr, srApplyMode, srAnnounceMention, SR_MODES }`,
  )(doc, (k) => prefs[k], t)
})
afterEach(async () => {
  await win.happyDOM.close()
})

const log = () => doc.getElementById('hs-mc-messages')
const region = () => doc.getElementById('hs-mc-sr-mentions')
const said = () => [...region().children].map((c) => c.textContent)

describe('the mode', () => {
  test('default is all; a junk or missing value falls back to all', () => {
    expect(api.srMode()).toBe('all')
    prefs.hs_sr_announce = 'loud'
    expect(api.srMode()).toBe('all')
    prefs.hs_sr_announce = 'mentions'
    expect(api.srMode()).toBe('mentions')
    prefs.hs_sr_announce = 'off'
    expect(api.srMode()).toBe('off')
  })

  test('the log is born polite (no attribute) in all, born quiet otherwise', () => {
    expect(api.srLogLiveAttr('all')).toBe('')
    expect(api.srLogLiveAttr('mentions')).toBe(' aria-live="off"')
    expect(api.srLogLiveAttr('off')).toBe(' aria-live="off"')
    prefs.hs_sr_announce = 'mentions'
    expect(api.srLogLiveAttr()).toBe(' aria-live="off"')
  })
})

describe('switching it live', () => {
  test('mentions and off silence the list; all gives it back its default', () => {
    api.srApplyMode('mentions')
    expect(log().getAttribute('aria-live')).toBe('off')
    api.srApplyMode('all')
    expect(log().hasAttribute('aria-live')).toBe(false)
    api.srApplyMode('off')
    expect(log().getAttribute('aria-live')).toBe('off')
  })

  test('leaving mentions mode empties the region so nothing is read late', () => {
    prefs.hs_sr_announce = 'mentions'
    api.srAnnounceMention({ user: 'bob', text: 'hi' })
    expect(said().length).toBe(1)
    api.srApplyMode('all')
    expect(said()).toEqual([])
  })

  test('with no page yet it does not throw', () => {
    doc.body.innerHTML = ''
    expect(() => api.srApplyMode('mentions')).not.toThrow()
  })
})

describe('what gets said', () => {
  test('mentions mode: a mention is said, as a plain sentence, in the region and not the list', () => {
    prefs.hs_sr_announce = 'mentions'
    api.srAnnounceMention({ user: 'bob', text: 'hello you' })
    expect(said()).toEqual(['bob mentioned you: hello you'])
    expect(log().children.length).toBe(0)
  })

  test('two mentions in the same breath are two lines, in order', () => {
    prefs.hs_sr_announce = 'mentions'
    api.srAnnounceMention({ user: 'a', text: 'one' })
    api.srAnnounceMention({ user: 'b', text: 'two' })
    expect(said()).toEqual(['a mentioned you: one', 'b mentioned you: two'])
  })

  test('all and off say nothing through the region (all already has the list)', () => {
    api.srAnnounceMention({ user: 'bob', text: 'hi' })
    prefs.hs_sr_announce = 'off'
    api.srAnnounceMention({ user: 'bob', text: 'hi' })
    expect(said()).toEqual([])
  })

  test('only the last five are kept, oldest out first', () => {
    prefs.hs_sr_announce = 'mentions'
    for (let i = 1; i <= 8; i++) api.srAnnounceMention({ user: 'u', text: `m${i}` })
    expect(said()).toEqual([4, 5, 6, 7, 8].map((i) => `u mentioned you: m${i}`))
  })

  test('a very long message is cut at 200 characters, so it can be said in one breath', () => {
    prefs.hs_sr_announce = 'mentions'
    api.srAnnounceMention({ user: 'u', text: 'x'.repeat(500) })
    expect(said()[0]).toBe(`u mentioned you: ${'x'.repeat(200)}…`)
  })

  test('the words are the catalog sentence, filled in with textContent (no markup is ever parsed)', () => {
    prefs.hs_sr_announce = 'mentions'
    api.srAnnounceMention({ user: 'u', text: '<img src=x onerror=1>' })
    expect(region().querySelector('img')).toBeNull()
    expect(said()[0]).toBe('u mentioned you: <img src=x onerror=1>')
  })

  test('a mention with no region or no message is ignored', () => {
    prefs.hs_sr_announce = 'mentions'
    expect(() => api.srAnnounceMention(null)).not.toThrow()
    doc.body.innerHTML = ''
    expect(() => api.srAnnounceMention({ user: 'u', text: 'x' })).not.toThrow()
  })
})

describe('wired into the page', () => {
  test('every live mention goes through notifyMention, which tells sr-announce first thing', () => {
    const src = read('src', 'multichat', 'mentions.js')
    const body = src.slice(src.search(/function notifyMention\(msg\b[^)]*\) \{/))
    const first = body
      .split('\n')
      .slice(1)
      .find((l) => l.trim() && !l.trim().startsWith('//'))
    expect(first.trim()).toBe('srAnnounceMention(msg)')
  })

  test("the overlay is built with the log's live attribute and the separate polite mentions region", () => {
    const src = read('src', 'multichat', 'main-overlay.js')
    expect(src).toContain('role="log"${srLogLiveAttr()}')
    const m = /<div id="hs-mc-sr-mentions"([^>]*)>/.exec(src)
    expect(m).toBeTruthy()
    expect(m[1]).toContain('class="hs-mc-sr-only"')
    expect(m[1]).toContain('role="log"')
    expect(m[1]).toContain('aria-live="polite"')
    expect(m[1]).toContain('aria-relevant="additions"')
    expect(m[1]).toContain("t('mc_a11y_mentions_aria')")
  })

  test('the region is hidden the way a screen reader still sees it (not display:none)', () => {
    const css = read('src', 'multichat', 'styles', '03-overlay-container.css')
    const rule = /\.hs-mc-sr-only\s*\{([^}]*)\}/.exec(css)[1]
    expect(rule).not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden/)
    expect(rule).toContain('clip: rect(0 0 0 0)')
  })

  test("the setting's applier is the one live switch", () => {
    expect(read('src', 'multichat', 'main-settings.js')).toContain('srAnnounce: (v) => srApplyMode(v)')
  })

  test('sr-announce.js is in the multichat bundle, after the overlay-keys it sits beside', () => {
    const build = read('build.js')
    expect(build).toContain("'sr-announce.js'")
  })
})

describe('the setting', () => {
  const def = SETTINGS.find((s) => s.key === 'hs_sr_announce')

  test('exists: an enum, default all, device-local, shown in the basic list under accessibility', () => {
    expect(def).toBeTruthy()
    expect(def.type).toBe('enum')
    expect(def.default).toBe('all')
    expect(def.scope).toBe('local')
    expect(def.basic).toBe(true)
    expect(def.section).toBe('accessibility')
    expect(def.options.map((o) => o.value)).toEqual(api.SR_MODES)
  })

  test('accepts its three values and nothing else', () => {
    for (const v of api.SR_MODES) expect(validateSettingValue(def, v)).toBe(true)
    expect(validateSettingValue(def, 'loud')).toBe(false)
    expect(validateSettingValue(def, true)).toBe(false)
  })

  test('the schema linter is happy with it', () => {
    expect(lintSettings(UI_SYNC_BLOCKLIST).filter((p) => p.includes('hs_sr_announce'))).toEqual([])
  })

  test('every label it shows is in all 34 catalogs', () => {
    const keys = [def.labelKey, def.tipKey, 'lib_sec_accessibility', ...def.options.map((o) => o.labelKey)]
    const dirs = readdirSync(join(ROOT, 'src', '_locales'))
    expect(dirs.length).toBe(34)
    for (const d of dirs) {
      const cat = JSON.parse(read('src', '_locales', d, 'messages.json'))
      for (const k of keys) expect(cat[k]?.message, `${d}.${k}`).toBeTruthy()
    }
  })

  test('its applier id exists and it applies at boot, so a saved "mentions" is in force from the first row', () => {
    expect(def.apply).toBe('srAnnounce')
    expect(def.applyOnLoad).toBe(true)
  })
})
