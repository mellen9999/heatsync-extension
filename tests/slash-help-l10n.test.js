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
