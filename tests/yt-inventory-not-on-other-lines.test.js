// rule 4 on youtube + the feed: your inventory never draws someone else's bare word.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rankEmotePool } from '../src/lib/utils.js'

const root = join(import.meta.dir, '..')
const yt = readFileSync(join(root, 'src', 'content', 'youtube-content.js'), 'utf8')
const i = yt.indexOf('  function rebuildEmoteMap(')
const body = yt.slice(i, yt.indexOf('\n  }\n', i) + 4)

function build(inventory, globals, owner = []) {
  const state = new Function(
    'rankEmotePool',
    `let emoteMap, renderMap, renderBlockedByName, blockedByName, variantsByName, lastInventory, lastGlobals
     let blockedEmotes = new Set()
     const channelEmotesByOwner = { me: ${JSON.stringify(owner)} }
     const ownedByMe = () => true
     const log = () => {}
     const syncRows = () => {}
     ${body}
     rebuildEmoteMap(${JSON.stringify(inventory)}, ${JSON.stringify(globals)})
     return { emoteMap, renderMap }`,
  )(rankEmotePool)
  return state
}

test('a word only you own types and completes, but is not drawn on other lines', () => {
  const { emoteMap, renderMap } = build([{ name: 'Mine', url: 'u1', hash: 'h1' }], [])
  expect(emoteMap.has('Mine')).toBe(true)
  expect(renderMap.has('Mine')).toBe(false)
})

test('owning W never hides the global W on other lines', () => {
  const { emoteMap, renderMap } = build(
    [{ name: 'W', url: 'mine', hash: 'h1' }],
    [{ name: 'W', url: 'glob', hash: 'g1', source: '7tv' }],
  )
  expect(renderMap.get('W').url).toBe('glob')
  expect(emoteMap.get('W').url).toBe('mine')
})

test('feed fallback reads channel + globals, not the viewer inventory', () => {
  const social = readFileSync(join(root, 'src', 'multichat', 'social.js'), 'utf8')
  expect(social).toContain('lookupPublicEmote(word)')
  expect(social).not.toMatch(/=\s*lookupEmote\(word\)/)
})

test('youtube right-click blocks only the emote under the cursor, not every version of the name', () => {
  const k = yt.indexOf('  function ytBlockKeys(')
  const fn = yt.slice(k, yt.indexOf('\n  }\n', k) + 4)
  const keys = new Function('blockedEmotes', `${fn}; return ytBlockKeys`)(new Set(['stv-hash']))
  const shown = { name: 'W', hash: 'bttv-hash' }
  expect(keys(shown, false)).toEqual(['bttv-hash'])
  expect(keys(shown, true)).toEqual([]) // not blocked, nothing to unblock
  expect(keys({ name: 'W', hash: 'stv-hash' }, true)).toEqual(['stv-hash'])
  expect(keys({ name: 'W' }, false)).toEqual(['W']) // hashless emote keys by name
  expect(yt).not.toContain('variantsByName.get(emote.name)')
})
