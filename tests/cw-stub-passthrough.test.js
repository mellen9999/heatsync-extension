/**
 * cw stub passthrough — get_sender_emotes hsEmotes loop (background.js).
 *
 * The server replaces filter-hidden emotes with {name, cw} stubs (no url)
 * instead of dropping them, so chat can paint a dashed-cyan "hidden by your
 * filter" placeholder. The BG loop must:
 *   - carry stubs through as state:'cw' entries (url '')
 *   - still skip url-less entries WITHOUT a cw label (old-shape safety)
 *   - let a stub override a same-name 7TV/BTTV entry (heatsync-set-wins
 *     precedence — otherwise a filtered emote leaks via the provider image)
 *
 * Source-slice harness: the loop is extracted from chrome/background.js via
 * markers and evaluated with an injected `collected` — marker drift fails
 * loudly, mirroring tests/background-helpers.test.js.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()

function sliceBetween(startMarker, endMarker) {
  const s = BG_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = BG_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return BG_SRC.slice(s, e)
}

const loopSrc = sliceBetween('const hsEmotes = hs?.emotes || []', '// Only cache when the result is trustworthy')
// Real added_at normalizer — the loop stamps addedAt via it (module-level in BG)
const helperSrc = sliceBetween('function emoteAddedAtMs', '\nfunction fetchEmoteInventory')

// (hs, collected) → collected after the heatsync-set merge loop
const runHsLoop = new Function('hs', 'collected', `${helperSrc}\n${loopSrc}\nreturn collected`)

const URL = 'https://cdn.heatsync.org/uploads/abc.webp'

describe('get_sender_emotes — cw stub passthrough', () => {
  test('stub (no url + cw) becomes a state:cw entry carrying the category', () => {
    const out = runHsLoop({ emotes: [{ name: 'BloodFest', cw: 'gore' }] }, {})
    expect(out.BloodFest).toMatchObject({ state: 'cw', cw: 'gore', url: '' })
  })

  test('custom_name wins as the stub key, same as full entries', () => {
    const out = runHsLoop({ emotes: [{ name: 'BloodFest', custom_name: 'blood2', cw: 'gore' }] }, {})
    expect(out.blood2).toMatchObject({ state: 'cw', cw: 'gore' })
    expect(out.BloodFest).toBeUndefined()
  })

  test('url-less entry WITHOUT cw is still skipped (old-shape safety)', () => {
    const out = runHsLoop(
      { emotes: [{ name: 'Broken' }, { name: 'AlsoBroken', cw: '' }, { name: 'BadCw', cw: 42 }] },
      {},
    )
    expect(out.Broken).toBeUndefined()
    expect(out.AlsoBroken).toBeUndefined()
    expect(out.BadCw).toBeUndefined()
  })

  test('stub overrides a same-name provider entry (no image leak past the filter)', () => {
    const collected = { BloodFest: { url: 'https://cdn.7tv.app/emote/x/1x.avif', source: '7tv', state: 'global' } }
    const out = runHsLoop({ emotes: [{ name: 'BloodFest', cw: 'sexual' }] }, collected)
    expect(out.BloodFest).toMatchObject({ state: 'cw', cw: 'sexual', url: '' })
  })

  test('full entries still merge normally beside stubs', () => {
    const out = runHsLoop(
      {
        emotes: [
          { name: 'Fine', url: URL, hash: 'h1' },
          { name: 'Hidden', cw: 'hate' },
        ],
      },
      {},
    )
    expect(out.Fine).toMatchObject({ url: URL, state: 'global' })
    expect(out.Hidden).toMatchObject({ state: 'cw', cw: 'hate' })
  })
})
