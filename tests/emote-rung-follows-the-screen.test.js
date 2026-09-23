/**
 * EVERY EMOTE THE EXTENSION DREW WAS THE 1x FILE, ON EVERY SCREEN.
 *
 * `getChatResUrl` picked a rung from the emote-size SETTING alone. Nothing in
 * the extension read `devicePixelRatio`, and `grep -rn srcset src/` returned
 * nothing at all. Measured on the live extension in Chrome, twitch.tv/xqc,
 * 2026-09-23:
 *
 *     247  img.hs-mc-emote on the page
 *       0  carrying a srcset
 *          every src the 1x rung — /1x.avif, /fullsize
 *
 * So on a DPR-2 laptop or any phone, a 32px file was drawn into a 32px box and
 * upscaled. Same defect the site repo carried until fc066d6bb.
 *
 * ⭐ WHY IT COSTS NO LAYOUT. The box is CSS — `height: auto` with
 * `max-height: var(--hs-emote-size)` (styles/10-emotes.css), and **max-height
 * only ever SHRINKS**. A 64px file in a 32px box renders 32px tall with its
 * aspect kept, so a denser rung changes the pixels and nothing else. That one
 * sentence is also why raising the emote-size setting needs the source to move
 * with the clamp, not just the clamp.
 *
 * ⚠ AND WHY NOT `srcset`, which is the web-standard answer:
 * `hsSwapRowEmotesForIdle` parks offscreen animated emotes by assigning
 * `img.src`, and a srcset candidate OUTRANKS src. Adding one would silently
 * break the offscreen animation gate and leave every parked row's decoder
 * running. One url per img keeps that gate honest — the test below pins it.
 *
 * These carve the REAL functions out of the source and run them, so they
 * cannot pass against a correct reimplementation.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
/** BOTH comment forms stripped, block comments included: the doc block above
 *  hsWantedRung EXPLAINS why there is no srcset, and on the first run that
 *  prose satisfied the check for a srcset. A comment that names a shape must
 *  never be able to stand in for the shape. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function carve(startAnchor, endAnchor) {
  const a = SRC.indexOf(startAnchor)
  if (a === -1) return null
  const b = SRC.indexOf(endAnchor, a)
  if (b === -1) return null
  return SRC.slice(a, b + endAnchor.length)
}

const RUNG_SRC = carve('function hsRungUrl(url, want) {', '\n}')
const WANT_SRC = carve('function hsWantedRung() {', '\n}')

const rungUrl = RUNG_SRC ? new Function(`${RUNG_SRC}; return hsRungUrl`)() : null
/** hsWantedRung closes over `emoteSize` and the global `devicePixelRatio`;
 *  hand it both so the real arithmetic runs. */
const wantedRung = WANT_SRC
  ? new Function('emoteSize', 'devicePixelRatio', `${WANT_SRC}; return hsWantedRung()`)
  : null

describe('the carve markers still exist', () => {
  test('both functions were found — otherwise everything below proves nothing', () => {
    expect(RUNG_SRC, 'hsRungUrl not found in emotes.js').toBeTruthy()
    expect(WANT_SRC, 'hsWantedRung not found in emotes.js').toBeTruthy()
  })
})

describe('the rung a screen needs', () => {
  test('a 1x screen gets exactly the size that was asked for', () => {
    expect(wantedRung(1, 1)).toBe(1)
    expect(wantedRung(2, 1)).toBe(2)
    expect(wantedRung(4, 1)).toBe(4)
  })

  test('a retina screen doubles it — this is the whole fix', () => {
    expect(wantedRung(1, 2)).toBe(2)
    expect(wantedRung(2, 2)).toBe(4)
  })

  test('stops at the top rung instead of asking for one that does not exist', () => {
    // 4 x 2 = 8, and no provider publishes an 8x. An honest ceiling.
    expect(wantedRung(4, 2)).toBe(4)
    expect(wantedRung(4, 3)).toBe(4)
  })

  test('treats a fractional phone ratio as retina', () => {
    // Titan 2 reports 2.5; a 1.5 threshold catches every real retina device
    // without promoting a 1.25 scaling factor into double the bytes.
    expect(wantedRung(1, 2.5)).toBe(2)
    expect(wantedRung(1, 1.5)).toBe(2)
    expect(wantedRung(1, 1.25)).toBe(1)
  })
})

describe('every provider reaches every rung it publishes', () => {
  // [label, 1x, 2x, top]
  const LADDER = [
    ['7tv', 'https://cdn.7tv.app/emote/01F6MZ/1x.avif', 'https://cdn.7tv.app/emote/01F6MZ/2x.avif', 'https://cdn.7tv.app/emote/01F6MZ/4x.avif'],
    ['bttv', 'https://cdn.betterttv.net/emote/5f1b/1x', 'https://cdn.betterttv.net/emote/5f1b/2x', 'https://cdn.betterttv.net/emote/5f1b/3x'],
    ['ffz', 'https://cdn.frankerfacez.com/emote/128054/1', 'https://cdn.frankerfacez.com/emote/128054/2', 'https://cdn.frankerfacez.com/emote/128054/4'],
    ['twitch', 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0', 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0'],
  ]

  for (const [label, one, two, top] of LADDER) {
    test(`${label}: 1 / 2 / 4 resolve from any starting rung`, () => {
      // Starting rung matters: twitch arrives from IRC at /2.0, and a cached
      // inventory url can be any of them.
      for (const start of [one, two, top]) {
        expect(rungUrl(start, 1), `${label} 1 from ${start}`).toBe(one)
        expect(rungUrl(start, 2), `${label} 2 from ${start}`).toBe(two)
        expect(rungUrl(start, 4), `${label} 4 from ${start}`).toBe(top)
      }
    })
  }

  test('leaves a single-file provider alone rather than inventing a path', () => {
    const kick = 'https://files.kick.com/emotes/5756668/fullsize'
    for (const want of [1, 2, 4]) expect(rungUrl(kick, want)).toBe(kick)
  })

  test('leaves a url it does not recognise alone', () => {
    const odd = 'https://example.com/whatever.png'
    for (const want of [1, 2, 4]) expect(rungUrl(odd, want)).toBe(odd)
  })
})

describe('the offscreen animation gate keeps working', () => {
  test('no emote img is given a srcset', () => {
    // ⛔ A srcset candidate outranks src, and hsSwapRowEmotesForIdle parks
    // offscreen animated emotes by assigning img.src. Adding one here would
    // leave every parked row decoding forever, invisibly.
    expect(/srcset/.test(CODE), 'emotes.js grew a srcset — see hsSwapRowEmotesForIdle').toBe(false)
  })

  test('the gate still swaps by src, which is what the rule above protects', () => {
    expect(CODE.includes('img.src = staticSrc')).toBe(true)
  })
})

describe('the resolution cache cannot outlive the answer', () => {
  test('is keyed on the effective rung, not on the setting', () => {
    // Dragging a window to a monitor with a different pixel ratio changes the
    // rung without the setting moving. A cache keyed on emoteSize would keep
    // serving the old screen's file for the rest of the session.
    const fn = carve('function getChatResUrl(url) {', '\n}')
    expect(fn, 'getChatResUrl not found').toBeTruthy()
    const body = fn.replace(/^\s*\/\/.*$/gm, '')
    expect(body).toContain('hsWantedRung()')
    expect(body).toContain('_resCacheSize !== want')
    expect(/_resCacheSize !== emoteSize/.test(body), 'still keyed on the setting alone').toBe(false)
  })
})
