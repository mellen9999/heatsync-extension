// rule 9: one block key per emote, never one shared by a whole cdn.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'

globalThis.escapeHtml = escapeHtml
globalThis.unescapeHtml = unescapeHtml
globalThis.cleanup = { setIntervalIfVisible: () => {}, persistInterval: () => {} }
globalThis.HS_MOD_TOKENS = mods.HS_MOD_TOKENS
globalThis.hsModClassify = mods.hsModClassify
globalThis.hsModBuildStyleAttr = mods.hsModBuildStyleAttr
globalThis.hsModInjectWrapperStyle = mods.hsModInjectWrapperStyle
globalThis.hsModComposeFilter = mods.hsModComposeFilter
globalThis.hsModHexToHue = mods.hsModHexToHue
globalThis.HS_MOD_C_HEX_RE = /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
globalThis.currentTab = 'chan-a'
globalThis.getCurrentChannel = () => 'chan-a'
globalThis.getLiveChannel = () => 'chan-a'
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined

const { emoteBlockKey } = await import('../src/multichat/emotes.js')

const A = 'https://cdn.7tv.app/emote/01AAAAAAAAAAAAAAAAAAAAAAAA/2x.webp'
const B = 'https://cdn.7tv.app/emote/01BBBBBBBBBBBBBBBBBBBBBBBB/2x.webp'

test('two emotes on one cdn get two keys', () => {
  expect(emoteBlockKey('W', A)).not.toBe(emoteBlockKey('W', B))
})

test('the full btoa(url) is the url fallback (what content.js files)', () => {
  expect(emoteBlockKey('W', A)).toBe(btoa(A))
})

test('a known hash wins; no url and no hash falls back to the name', () => {
  expect(emoteBlockKey('W', A, 'h1')).toBe('h1')
  expect(emoteBlockKey('W')).toBe('W')
})

test('the picker button files the same per-emote key (no 24-byte url prefix left)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'chrome', 'heatsync-button.js'), 'utf8')
  expect(src).not.toMatch(/btoa\([^)]*\)\.slice\(0, ?24\)/)
  expect(src).toContain('function emoteBlockKey')
})
