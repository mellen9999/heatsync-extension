// Words that reached the screen in english in every language, found by driving the real ui in
// german, japanese, arabic, russian and greek (e2e s27, 11-17): the add / cancel / save / reset
// buttons of the channel forms, the four sound names in the settings select, and a popup that
// stayed left-to-right in arabic while the welcome page and the panel mirrored. Each one sat
// behind a helper or a table, where a plain "is this string a literal" look never reaches.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS } from '../src/lib/settings-schema.js'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8')
const en = JSON.parse(read('src', '_locales', 'en', 'messages.json'))

describe('form buttons', () => {
  test('no button is built from an english word', () => {
    const hits = []
    for (const f of readdirSync(join(ROOT, 'src', 'multichat')).filter((n) => n.endsWith('.js'))) {
      read('src', 'multichat', f)
        .split('\n')
        .forEach((line, i) => {
          if (/\bmakeMcBtn\(\s*['"`]/.test(line)) hits.push(`${f}:${i + 1} ${line.trim()}`)
        })
    }
    expect(hits).toEqual([])
  })

  test('the reset button has its word in every language', () => {
    for (const code of readdirSync(join(ROOT, 'src', '_locales'))) {
      const loc = JSON.parse(read('src', '_locales', code, 'messages.json'))
      expect([code, !!loc.mc_ch_reset?.message]).toEqual([code, true])
    }
  })
})

describe('settings options', () => {
  // "1x", "24h" read the same everywhere; a word does not
  const isWord = (s) => /\p{L}{3,}/u.test(s) && !/^\d/.test(s)

  test('every option that is a word names its message', () => {
    const bare = []
    for (const def of SETTINGS)
      for (const o of Array.isArray(def.options) ? def.options : [])
        if (typeof o.label === 'string' && isWord(o.label) && !o.labelKey) bare.push(`${def.key}: ${o.label}`)
    expect(bare).toEqual([])
  })

  test('every option message exists and says what the english fallback says', () => {
    const off = []
    for (const def of SETTINGS)
      for (const o of Array.isArray(def.options) ? def.options : []) {
        if (!o.labelKey) continue
        if (!en[o.labelKey]) off.push(`${def.key}: ${o.labelKey} is not a message`)
      }
    expect(off).toEqual([])
    const sound = SETTINGS.find((d) => d.key === 'mentionSound')
    expect(sound.options.map((o) => en[o.labelKey].message)).toEqual(['ping', 'blip', 'knock', 'chime', 'my file'])
  })
})

describe('the @mention sound row', () => {
  const SRC = read('src', 'multichat', 'sound-ui.js')
  const row = (name) => {
    const g = {
      getSetting: (k) => (k === 'mentionSoundName' ? name : undefined),
      _rowModified: () => false,
      _setLabel: () => 'sound file',
      _setSectionTitle: () => '',
      hsXButtonHtml: () => '<x>',
      t: (k) => ({ mc_sfx_none: 'ファイルはまだありません' })[k] || k,
      escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
      SFX_PRESETS: {},
      SFX_CUSTOM: 'custom',
      FR_BTN: 'btn',
      document: {},
    }
    const html = new Function(...Object.keys(g), `${SRC}\nreturn sfxMentionRow`)(...Object.values(g))({
      key: 'mentionSoundName',
      category: 'notifs',
    }).html
    return /<span class="hs-mc-set-range-val"[^>]*>[^<]*<\/span>/.exec(html)[0]
  }

  test('"no file yet" is never cut to a width: it was 110px wide and lost its end in japanese and greek', () => {
    const span = row('')
    expect(span).toContain('ファイルはまだありません')
    expect(span).not.toContain('max-width')
  })

  test('a file name is still cut to fit, and the whole name is one hover away', () => {
    const span = row('a-very-long-recording-of-a-doorbell.mp3')
    expect(span).toContain('max-width:110px')
    expect(span).toContain('title="a-very-long-recording-of-a-doorbell.mp3"')
  })
})

describe('the popup in a right-to-left language', () => {
  const JS = read('src', 'content', 'popup.js')
  const HTML = read('chrome', 'popup.html')

  test('the page takes its direction from the browser language', () => {
    const line = JS.split('\n').find((l) => l.includes('documentElement.dir'))
    expect(line).toBeDefined()
    const dirFor = (bidi) => {
      const document = { documentElement: {} }
      new Function('document', 't', line)(document, (k) => (k === '@@bidi_dir' ? bidi : ''))
      return document.documentElement.dir
    }
    expect(dirFor('rtl')).toBe('rtl')
    expect(dirFor('ltr')).toBe('ltr')
    expect(dirFor('')).toBe('ltr') // no i18n at all: never an empty or junk direction
  })

  test('no rule names a side: a separator on the "right" lands on the outer edge once mirrored', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(HTML)[1].replace(/\/\*[\s\S]*?\*\//g, '')
    const sided = css.match(
      /\b(?:margin|padding|border)-(?:left|right)\b[^;]*;|\b(?:left|right)\s*:[^;]*;|text-align\s*:\s*(?:left|right)/g,
    )
    expect(sided || []).toEqual([])
  })
})
