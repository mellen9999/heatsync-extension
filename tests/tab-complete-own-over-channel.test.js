/**
 * A name you own that the channel also defines under a DIFFERENT picture:
 * Tab must show yours, because that is what the sent line draws (emotes.js
 * _lookup resolves the sender's own set before the channel's, and the ref the
 * server vouches is that same set). The merge map used to let the channel
 * entry overwrite yours, so the box showed the room's YESIDOTHINKSO and the
 * sent row drew the one in your set (nl_kripp, 2026-11-05).
 *
 * _getMergedAcEmotes is carved from the content-script bundle source, like
 * the other tab-complete tests.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const carve = (a, b) => {
  const i = SRC.indexOf(a)
  const j = SRC.indexOf(b)
  if (i === -1 || j === -1 || j <= i) throw new Error(`carve markers not found: ${a}`)
  return SRC.slice(i, j)
}
const picSrc = carve('const _AC_PIC_RE =', 'let _acRemoteToken = 0')
const mergeSrc = carve('let _acMergeCache = null', '// Shared exclusion check for the autocomplete pool')

const OWN = 'https://cdn.7tv.app/emote/01F64J1AMG000AR232513EFJBF/1x.webp'
const CHAN = 'https://cdn.7tv.app/emote/01FNSCJEGG000EJT2EVEY3F98H/1x.webp'
const CHAN_SAME = 'https://cdn.7tv.app/emote/01F64J1AMG000AR232513EFJBF/2x.webp'

function rig({ own = OWN, chan = CHAN, settings = {}, extra = [] } = {}) {
  const viewerPersonalEmotes = new Map([
    ...(own ? [['YESIDOTHINKSO', { url: own, source: 'heatsync', state: 'owned' }]] : []),
    ...extra,
  ])
  const pool = new Map(chan ? [['YESIDOTHINKSO', { url: chan, source: '7tv', state: 'channel' }]] : [])
  const env = {
    emoteCache: new Map(),
    viewerPersonalEmotes,
    channelEmoteCaches: { nl_kripp: pool },
    currentTab: 'nl_kripp',
    getCurrentChannel: () => 'nl_kripp',
    activeTabEmotePools: () => [pool],
    getSetting: (k) => (k in settings ? settings[k] : undefined),
  }
  const names = Object.keys(env)
  const fn = new Function(...names, `${picSrc}\n${mergeSrc}; return _getMergedAcEmotes`)(...names.map((k) => env[k]))
  return fn()
}

describe('tab-complete: a name you own under a different picture than the channel', () => {
  test('yours stays under the name (tier 1) — the sent line draws it', () => {
    const { acEmotes, tierByName } = rig()
    expect(acEmotes.get('YESIDOTHINKSO').url).toBe(OWN)
    expect(tierByName.get('YESIDOTHINKSO')).toBe(1)
  })

  test('same picture in both: the channel entry wins as before (tier 0)', () => {
    const { acEmotes, tierByName } = rig({ chan: CHAN_SAME })
    expect(acEmotes.get('YESIDOTHINKSO').url).toBe(CHAN_SAME)
    expect(tierByName.get('YESIDOTHINKSO')).toBe(0)
  })

  test('not owned: the channel entry is the one offered', () => {
    const { acEmotes, tierByName } = rig({ own: null })
    expect(acEmotes.get('YESIDOTHINKSO').url).toBe(CHAN)
    expect(tierByName.get('YESIDOTHINKSO')).toBe(0)
  })

  test('inventory renders off: rows draw the channel copy, so Tab offers it too', () => {
    const { acEmotes, tierByName } = rig({ settings: { renderInventoryEmotes: false } })
    expect(acEmotes.get('YESIDOTHINKSO').url).toBe(CHAN)
    expect(tierByName.get('YESIDOTHINKSO')).toBe(0)
  })

  test('inventory suggestions off: own names are not in the map, the channel copy is offered', () => {
    const { acEmotes, tierByName } = rig({ settings: { suggestInventoryEmotes: false } })
    expect(acEmotes.get('YESIDOTHINKSO').url).toBe(CHAN)
    expect(tierByName.get('YESIDOTHINKSO')).toBe(0)
  })
})

// Your twitch sub emotes ride in viewerPersonalEmotes (the /api/user/emotes
// walk and twitch's own picker both land there) but they are not inventory:
// twitch lets you type them anywhere. The toggle hid them too, so a subbed
// dellorEat never completed while the app offered it (2026-11-05).
describe('tab-complete: twitch sub emotes are not inventory', () => {
  const SUB = 'https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_x/static/dark/3.0'
  const extra = [
    ['dellorEat', { url: SUB, source: 'heatsync', state: 'owned', subscription: true }],
    ['nativeSub', { url: SUB, source: 'twitch', state: 'owned', subscription: true, owner: 'dellor' }],
  ]

  test('inventory suggestions off: sub emotes still complete, inventory does not', () => {
    const { acEmotes, tierByName } = rig({ own: OWN, chan: null, extra, settings: { suggestInventoryEmotes: false } })
    expect(acEmotes.get('dellorEat')?.url).toBe(SUB)
    expect(acEmotes.get('nativeSub')?.url).toBe(SUB)
    expect(tierByName.get('dellorEat')).toBe(1)
    expect(acEmotes.has('YESIDOTHINKSO')).toBe(false)
  })

  test('inventory suggestions on: both complete', () => {
    const { acEmotes } = rig({ own: OWN, chan: null, extra })
    expect(acEmotes.has('dellorEat')).toBe(true)
    expect(acEmotes.get('YESIDOTHINKSO')?.url).toBe(OWN)
  })
})
