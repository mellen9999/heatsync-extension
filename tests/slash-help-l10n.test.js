/**
 * The help pane's command list is the registry's own text in the viewer's language: section titles and
 * descriptions go through t(), the command names and argument hints never do. Every listed command and
 * section has a catalog entry that says the same thing as the registry in english.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SLASH_REGISTRY, SLASH_SECTIONS, slashCommandsFor, slashHelpText } from '../src/multichat/slash-registry.js'

const EN = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))
const SETTINGS_UI = readFileSync(new URL('../src/multichat/settings-ui.js', import.meta.url), 'utf8')

describe('slashHelpText', () => {
  test('every usage stands apart from its words: two spaces, or the words on the next line', () => {
    for (const surface of ['ext', 'site']) {
      const usages = slashCommandsFor(surface).map((c) => `/${c.cmd}${c.args ? ` ${c.args}` : ''}`)
      const lines = slashHelpText(surface).split('\n')
      let wrapped = 0
      for (const u of usages) {
        const at = lines.findIndex((l) => l.startsWith(`${u} `) || l === u)
        expect(at).toBeGreaterThanOrEqual(0)
        if (lines[at] === u) {
          wrapped++
          expect(lines[at + 1]).toMatch(/^ {3,}\S/) // the words, under the column
        } else expect(lines[at].slice(u.length)).toMatch(/^ {2,}\S/)
      }
      // /prediction's signature is past the column: the case this guards is real
      expect(wrapped).toBeGreaterThan(0)
    }
  })

  test('without a translator it is the registry text, as before', () => {
    const out = slashHelpText('ext')
    for (const sec of SLASH_SECTIONS) expect(out).toContain(`── ${sec.title}`)
    for (const c of slashCommandsFor('ext')) expect(out).toContain(c.desc)
  })

  test('a translator replaces titles and descriptions, never command names or argument hints', () => {
    const out = slashHelpText('ext', { title: (s) => `T:${s.key}`, desc: (c) => `D:${c.cmd}` })
    for (const sec of SLASH_SECTIONS) expect(out).toContain(`── T:${sec.key}`)
    for (const c of slashCommandsFor('ext')) {
      expect(out).toContain(`/${c.cmd}${c.args ? ` ${c.args}` : ''}`)
      expect(out).toContain(`D:${c.cmd}`)
      expect(out).not.toContain(c.desc)
    }
  })

  test('the settings help pane passes its own t() lookups', () => {
    expect(SETTINGS_UI).toContain("slashHelpText('ext', { title: (s) => t(`slash_sec_${s.key}`), desc: slashDesc })")
  })
})

describe('the catalog says what the registry says', () => {
  test('every section title', () => {
    for (const sec of SLASH_SECTIONS) expect(EN[`slash_sec_${sec.key}`]?.message, sec.key).toBe(sec.title)
  })
  test('every advertised command description', () => {
    for (const c of SLASH_REGISTRY.filter((x) => !x.hidden))
      expect(EN[`slash_desc_${c.cmd}`]?.message, c.cmd).toBe(c.desc)
  })
})
