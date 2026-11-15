/**
 * tabOpensEmoteList: Tab on a word opens the ranked suggestion list (the one
 * ":word" pops) instead of completing in place. Off by default, so the classic
 * Tab cycle is untouched unless the viewer turns it on.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n')
const INPUT = read('src', 'multichat', 'input.js')
const SCHEMA = read('src', 'lib', 'settings-schema.js')
const TAB_LIST = read('src', 'multichat', 'tab-list.js')
const BUILD = read('build.js')
const body = (name, src = INPUT) => {
  const a = src.indexOf(`function ${name}(`)
  if (a < 0) throw new Error(`${name} not found`)
  return src.slice(a, src.indexOf('\n}\n', a))
}

describe('tab opens the emote list', () => {
  test('the setting exists, off by default, in the input section', () => {
    const a = SCHEMA.indexOf("key: 'tabOpensEmoteList'")
    expect(a).toBeGreaterThan(-1)
    const entry = SCHEMA.slice(a, SCHEMA.indexOf('\n  },', a))
    expect(entry).toContain("type: 'bool'")
    expect(entry).toContain('default: false')
    expect(entry).toContain("section: 'input'")
    expect(entry).toContain("labelKey: 'mc_settings_tab_list'")
  })

  test('first Tab on a word opens the list when the setting is on, else completes in place', () => {
    const at = INPUT.indexOf("getSetting('tabOpensEmoteList') === true && openTabEmoteList(word)")
    expect(at).toBeGreaterThan(-1)
    // it sits before the classic first-Tab completion of the same word
    expect(at).toBeLessThan(INPUT.indexOf('const matches = findEmoteMatches(word)', at))
  })

  test('tab-list.js ships in the multichat bundle, after input.js', () => {
    const a = BUILD.indexOf("'input.js',")
    const b = BUILD.indexOf("'tab-list.js',")
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
  })

  test('the list is the colon list, for the bare word, local only', () => {
    const open = body('openTabEmoteList', TAB_LIST)
    expect(open).toContain('findEmoteMatches(word).slice(0, EMOJI_DROPDOWN_MAX)')
    expect(open).toContain('emojiAcState.plain = true')
    expect(open).toContain('showEmojiDropdown(matches, 0)')
    expect(open).toContain('return false') // nothing local: fall back to the classic Tab
    expect(open).not.toContain('fetchRemoteEmoteMatches')
  })

  test('picking from a Tab-opened list keeps cycling the bare word, not ":word"', () => {
    expect(body('insertEmojiFromDropdown')).toContain(
      'acState.search = emojiAcState.plain ? emojiAcState.query : `:${emojiAcState.query}`',
    )
    expect(body('hideEmojiDropdown')).toContain('emojiAcState.plain = false')
    expect(body('checkEmojiAutocomplete')).toContain('emojiAcState.plain = false')
  })

  test('every locale names the setting', () => {
    for (const loc of readdirSync(join(ROOT, 'src', '_locales'))) {
      const j = JSON.parse(read('src', '_locales', loc, 'messages.json'))
      expect(j.mc_settings_tab_list?.message, loc).toBeTruthy()
      expect(j.mc_settings_tab_list_desc?.message, loc).toBeTruthy()
    }
  })
})
