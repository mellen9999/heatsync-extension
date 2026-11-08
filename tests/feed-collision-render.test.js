// A feed post / reply is a line like any other: its emote_refs are the author's pick (rule 2); a bare
// word falls to channel then global and never your inventory (rules 3, 4); a block hides the exact
// emote only (rule 9). Rendered through the real renderFeedContent + the real lookups.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, safeUrl, unescapeHtml } from '../src/lib/utils.js'

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
globalThis.linksEnabled = false
globalThis.getSetting = () => undefined

const em = await import('../src/multichat/emotes.js')
const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const a = src.indexOf('function formatText(')
const b = src.indexOf('function formatRelativeTime(')
const body = src.slice(a, b)

const U = (id) => `https://cdn.7tv.app/emote/${id}/2x.webp`
const MINE = U('01MINE0000000000000000000A')
const CHAN = U('01CHAN0000000000000000000B')
const GLOB = U('01GLOB0000000000000000000C')
const REF = U('01REFF0000000000000000000D')

function render(text, refs, { blocked = [] } = {}) {
  globalThis.currentTab = 'chan-x'
  globalThis.getCurrentChannel = () => 'chan-x'
  globalThis.getLiveChannel = () => 'chan-x'
  globalThis.getChannelById = () => null
  em.viewerPersonalEmotes.clear()
  em.emoteCache.clear()
  for (const k of Object.keys(em.channelEmoteCaches)) delete em.channelEmoteCaches[k]
  em.inventoryEmotes.clear()
  em.viewerPersonalEmotes.set('W', { url: MINE, source: '7tv', state: 'owned', hash: 'mine' })
  em.inventoryEmotes.add('W')
  em.emoteCache.set('W', { url: GLOB, source: '7tv', state: 'global', hash: 'glob' })
  em.channelEmoteCaches['chan-x'] = new Map([['W', { url: CHAN, source: 'ffz', state: 'channel', hash: 'chan' }]])
  const fn = new Function(
    'escapeHtml',
    'safeUrl',
    'lookupPublicEmote',
    'emoteIsBlocked',
    'blockedEmoteNames',
    'getEmoteState',
    'HS_TRANSPARENT_PX',
    `${body}; return renderFeedContent`,
  )
  return fn(
    escapeHtml,
    safeUrl,
    em.lookupPublicEmote,
    (_name, e) => blocked.includes(e?.hash),
    new Set(),
    () => 'global',
    'data:,',
  )(text, refs)
}

test("another author's bare W draws the channel W, never the viewer's own", () => {
  const out = render('hi W', null)
  expect(out).toContain('01CHAN')
  expect(out).not.toContain('01MINE')
})

test("the post's own ref wins over the channel W (rule 2)", () => {
  const out = render('hi W', { W: { url: REF, provider: '7tv', hash: 'ref' } })
  expect(out).toContain('01REFF')
  expect(out).not.toContain('01CHAN')
})

test('with no channel W the global W draws, still not the inventory one', () => {
  const out = (() => {
    const r = render('hi W', null)
    return r
  })()
  expect(out).not.toContain('01MINE')
})

test('blocking the channel W boxes that one, not a ref-carried W of another author', () => {
  const blockedChan = render('hi W', null, { blocked: ['chan'] })
  expect(blockedChan).toContain('hs-state-blocked')
  const ref = render('hi W', { W: { url: REF, provider: '7tv', hash: 'ref' } }, { blocked: ['chan'] })
  expect(ref).toContain('01REFF')
  expect(ref).not.toContain('hs-state-blocked')
})
