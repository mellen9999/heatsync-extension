import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPaintLookupSafeId } from '../src/lib/paint-spec.js'
import { escapeHtml } from '../src/lib/utils.js'

// A went-live / switch row names the streamer like a chat row: colour, paint
// and the third-party badges keyed to the twitch id chat already resolved.
const knownUserIds = new Map([['twitch:quin69', '71092938']])
const G = {
  isPaintLookupSafeId,
  escapeHtml,
  sanitizeColor: (c) => c,
  hsUsernameColor: () => '#8888ff',
  getHsPickedColor: () => null,
  knownUserIds,
  userKey: (login, plat) => `${plat}:${login}`,
  queuePaintLookup() {},
  queueMcCosmeticsLookup() {},
  queueNameColorLookup() {},
  hsPaintRender: (uid, name) =>
    uid === '71092938' ? { cls: 'hs-paint-x', html: escapeHtml(name), splitAttr: ' data-hs-split="1"' } : null,
  paintPhaseNow: () => '0s',
  hsNameColourDecl: (c) => `--hs-name-c:${c}`,
  getMcPaintStyle: () => '',
  renderThirdPartyBadges: (uid) => `<img class="hs-mc-bttv-badge" data-for="${uid}">`,
}
const saved = {}
let ns
beforeAll(async () => {
  for (const [k, v] of Object.entries(G)) {
    saved[k] = globalThis[k]
    globalThis[k] = v
  }
  ns = await import('../src/multichat/name-style.js')
})
afterAll(() => {
  for (const k of Object.keys(G)) globalThis[k] = saved[k]
})

describe('stream-event streamer name', () => {
  test('a known twitch id gives the name its paint and its badges', () => {
    const p = ns.hsNameParts({ name: 'quin69', platform: 'twitch', colour: '', login: 'quin69' })
    expect(p.uid).toBe('71092938')
    expect(p.cls).toBe('hs-paint-x')
    expect(ns.hsNameBadges(p)).toContain('hs-mc-bttv-badge')
  })
  test('an unknown id is bare: no paint, no badges', () => {
    const p = ns.hsNameParts({ name: 'nobody', platform: 'twitch', colour: '', login: 'nobody' })
    expect(p.cls).toBe('')
    expect(ns.hsNameBadges(p)).toBe('')
  })
  test('the row puts the badges before the name', () => {
    const main = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
    expect(main).toContain('evtBadges +')
  })
})
