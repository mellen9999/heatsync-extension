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
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'heatsync-button.js'), 'utf8')
  expect(src).not.toMatch(/btoa\([^)]*\)\.slice\(0, ?24\)/)
  expect(src).toContain('function emoteBlockKey')
})

test('picker button: owned means the same emote, and name dedupe is case-exact', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'content', 'heatsync-button.js'), 'utf8')
  expect(src).toContain('mine.hash !== emote.hash')
  expect(src).not.toContain("_n_${(e.name || '').toLowerCase()}")
})

test('two blocked emotes with one name keep two records; unblocking one leaves the other', async () => {
  const em = await import('../src/multichat/emotes.js')
  globalThis.cleanup = { ...globalThis.cleanup, setTimeout: () => 0 } // the persist debounce is not under test
  em.blockedEmoteFallback.clear()
  const A2 = 'https://cdn.7tv.app/emote/01AAAAAAAAAAAAAAAAAAAAAAAA/2x.webp'
  const B2 = 'https://cdn.betterttv.net/emote/bbbb/2x.webp'
  em.rememberBlockedEmote('W', A2, '7tv', false, 'hashA')
  em.rememberBlockedEmote('W', B2, 'bttv', false, 'hashB')
  expect(em.blockedFallbacksForName('W').map((r) => r.hash)).toEqual(['hashA', 'hashB'])
  // the same picture re-remembered with no key keeps its key instead of making a third record
  em.rememberBlockedEmote('W', A2, '7tv', false)
  expect(em.blockedFallbacksForName('W').length).toBe(2)
  expect(em.blockedFallbacksForName('W').find((r) => r.url === A2).hash).toBe('hashA')
  em.blockedEmoteFallback.clear()
})

test('tab-complete and the composer judge a blocked name per emote', async () => {
  const em = await import('../src/multichat/emotes.js')
  const { readFileSync } = await import('node:fs')
  const input = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
  const i = input.indexOf('function _hsAcEmoteBlocked(')
  const fn = input.slice(i, input.indexOf('\n}\n', i) + 3)
  const acBlocked = new Function(
    'emoteIsBlocked',
    'blockedEmoteNames',
    `const hsEmoteHiddenForViewer = () => false, hsChannelNsfwHidden = () => false, unescapeHtml = (x) => x\n${fn}; return _hsAcEmoteBlocked`,
  )(em.emoteIsBlocked, em.blockedEmoteNames)
  globalThis.cleanup = { ...globalThis.cleanup, setTimeout: () => 0 }
  em.blockedEmoteFallback.clear()
  em.blockedEmoteNames.add('W')
  em.rememberBlockedEmote('W', 'https://cdn.7tv.app/emote/AAAA/2x.webp', '7tv', false, 'hashA')
  try {
    expect(acBlocked('W', { hash: 'hashA', url: 'https://cdn.7tv.app/emote/AAAA/2x.webp' })).toBe(true)
    expect(acBlocked('W', { hash: 'hashB', url: 'https://cdn.betterttv.net/emote/BBBB/2x.webp' })).toBe(false)
  } finally {
    em.blockedEmoteFallback.clear()
    em.blockedEmoteNames.delete('W')
  }
})
