/**
 * Hovering a painted name chips it (and every copy of it) white/black with
 * overrides alone: the paint's animations keep running underneath, so nothing
 * has to be resumed, recreated or re-seeked on the way out.
 *
 * The old freeze paused every visible copy of the name, deleted its scene
 * plates (content:none) and hid its fill boxes (display:none); the release
 * rebuilt and re-seeked all of it in the mouseout task — ~1s main-thread stall
 * with a dozen copies of a scene paint on screen (traced 2026-10-31).
 *
 * paints.js pulls in bundle-only globals at module scope, so the pieces are
 * extracted by source slicing + `new Function` (house pattern).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'paints.js'), 'utf8')

function slice(sig) {
  const start = SRC.indexOf(sig)
  expect(start, `${sig} vanished from paints.js`).toBeGreaterThan(-1)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}' && --depth === 0) break
  }
  return SRC.slice(start, i + 1)
}

const hsChipRules = new Function(`${slice('function hsChipRules(sel)')}; return hsChipRules`)()
const CSS = { escape: (v) => v.replace(/[^\w-]/g, '\\$&') }
const hsPaintEchoFor = new Function('CSS', `${slice('function hsPaintEchoFor(el)')}; return hsPaintEchoFor`)(CSS)

describe('paint hover chip', () => {
  const rules = hsChipRules(':hover')

  test('white chip, black text', () => {
    expect(rules).toContain('[class*="hsp-"]:hover,[class*="hsp-"]:hover span{background:#fff !important;')
    expect(rules).toContain('color:#000 !important')
  })

  test('never pauses, removes or display-hides anything', () => {
    expect(rules).not.toContain('animation-play-state')
    expect(rules).not.toContain('content:none')
    expect(rules).not.toContain('display:none')
    expect(rules).toMatch(/:hover::before[^{]*:hover>i[^{]*\{visibility:hidden !important;\}/)
  })

  test('real pointers only', () => {
    expect(SRC).toContain("`@media (hover: hover){${hsChipRules(':hover')}}`")
    expect(SRC).toContain('`@media (hover: hover){${hsChipRules(key)}}`')
  })

  test('no per-copy work: no classing, no resync', () => {
    expect(SRC).not.toContain('hsp-hover')
    expect(SRC).not.toContain('resyncAnimationPhases(')
  })
})

describe('hover echo: every copy of the hovered name', () => {
  const el = (cls, username) => ({ classList: ['hs-mc-user', cls], dataset: username ? { username } : {} })

  test('a row name matches its paint and its username, plus copies with no username', () => {
    expect(hsPaintEchoFor(el('hsp-abc', 'Ennortix'))).toBe(
      '.hsp-abc:is([data-username="ennortix" i],:not([data-username]))',
    )
  })

  test('a mention chip (no username) matches its paint', () => {
    expect(hsPaintEchoFor(el('hsp-abc'))).toBe('.hsp-abc')
  })

  test('an unpainted element yields nothing', () => {
    expect(hsPaintEchoFor({ classList: ['x'], dataset: {} })).toBe('')
  })

  test('a hostile username is escaped', () => {
    expect(hsPaintEchoFor(el('hsp-abc', 'a"]{x}'))).toContain('a\\"\\]\\{x\\}')
  })
})
