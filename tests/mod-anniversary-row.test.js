/**
 * A mod anniversary is the mods' own row: twitch's msg-id `modiversary`
 * (read off twitch's irc handler, 2026-11-09 — the dashed spellings we knew
 * were never what it sends) wears the green fill, not a sub's navy.
 *
 * The classifier and rowFill are carved from source and run for real.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const MSGS = readFileSync(new URL('../src/multichat/main-messages.js', import.meta.url), 'utf8')
const FILL = readFileSync(new URL('../src/multichat/fill-family.js', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../src/multichat/styles/21-brand-rows.css', import.meta.url), 'utf8')

const noticeKind = (() => {
  const from = MSGS.indexOf('const noticeKind = (() => {')
  const body = MSGS.slice(from + 'const noticeKind = '.length, MSGS.indexOf('\n  })()', from) + 7)
  return new Function('m', `return ${body}`)
})()
const rowFill = (() => {
  const from = FILL.indexOf('const NAVY_NOTICES')
  const src = FILL.slice(from, FILL.indexOf('\n}', FILL.indexOf('function rowFill(')) + 2)
  return new Function(`${src}\nreturn rowFill`)()
})()
const fillOf = (cls) => rowFill({ className: cls, classList: { contains: (c) => cls.split(' ').includes(c) } })

describe('mod anniversary row', () => {
  test('twitch’s own msg-id and both old spellings are a mod anniversary', () => {
    for (const msgId of ['modiversary', 'mod-anniversary', 'mod_anniversary']) {
      expect(noticeKind({ type: 'usernotice', msgId })).toBe('hs-mc-notice-mod-anniversary')
    }
  })

  test('it wears green; a resub stays navy', () => {
    expect(fillOf('hs-mc-msg hs-mc-notice-mod-anniversary')).toBe('green')
    expect(fillOf('hs-mc-msg hs-mc-notice-sub')).toBe('navy')
  })

  test('the green fill is painted, with its label colour', () => {
    expect(CSS).toMatch(
      /\.hs-fill-green\s*\{\s*background:\s*var\(--brand-fill-green\);\s*--hs-label:\s*var\(--brand-label-green\);/,
    )
  })
})
