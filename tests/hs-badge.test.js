/**
 * The heatsync badge mark beside a name (src/multichat/badges.js).
 *
 * The server sends one id per user on the /api/paints batch; glyph, colour and
 * words are ours. These pin what a hostile or newer id does, where the mark
 * sits, and that every word it needs exists in all 34 locales.
 *
 * No DOM library here (house pattern): a few linked fake elements stand in for
 * the row, enough to prove placement and idempotence. The real browser run is
 * scripts/render-extension.ts ("a badge from the cosmetics batch ...").
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BADGES, badgeById } from '../src/lib/badge-catalogue.js'
import { escapeHtml } from '../src/lib/utils.js'
import {
  buildHsBadgeToken,
  getHsBadgeId,
  hsBadgeTitle,
  placeHsBadgeToken,
  renderHsBadgeToken,
  setHsBadgeEntry,
} from '../src/multichat/badges.js'

const ROOT = join(import.meta.dir, '..')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

class El {
  constructor(cls = '') {
    this.classList = { contains: (c) => this.cls.split(' ').includes(c) }
    this.cls = cls
    this.dataset = {}
    this.style = {}
    this.next = null
    this.prev = null
  }
  set className(v) {
    this.cls = v
  }
  get className() {
    return this.cls
  }
  get nextElementSibling() {
    return this.next
  }
  insertAdjacentElement(_where, el) {
    el.prev = this
    el.next = this.next
    if (this.next) this.next.prev = el
    this.next = el
    return el
  }
  remove() {
    if (this.prev) this.prev.next = this.next
    if (this.next) this.next.prev = this.prev
  }
}

const chain = (el) => {
  const out = []
  for (let e = el; e; e = e.next) out.push(e.cls.split(' ')[0] + (e.dataset.badge ? `:${e.dataset.badge}` : ''))
  return out
}

// bun runs every test file in one global: put back whatever we borrowed
const KEYS = ['t', 'badgeById', 'escapeHtml', 'document']
const saved = {}
afterEach(() => {
  for (const k of KEYS) {
    if (k in saved) globalThis[k] = saved[k]
    else delete globalThis[k]
  }
})

beforeEach(() => {
  for (const k of KEYS) if (!(k in saved) && k in globalThis) saved[k] = globalThis[k]
  globalThis.t = (k) => EN[k]?.message ?? k
  globalThis.badgeById = badgeById
  globalThis.escapeHtml = escapeHtml
  globalThis.document = { createElement: () => new El() }
})

describe('cache', () => {
  test('keeps a plain id, treats anything else as none', () => {
    setHsBadgeEntry('u1', 'plus_3m')
    expect(getHsBadgeId('u1')).toBe('plus_3m')
    for (const bad of ['<img onerror=x>', 'X'.repeat(40), '', 5, null, undefined, { a: 1 }]) {
      setHsBadgeEntry('u2', bad)
      expect(getHsBadgeId('u2'), String(bad)).toBeNull()
    }
    expect(getHsBadgeId('never-seen')).toBeNull()
  })

  test('is bounded: the oldest entry goes first', () => {
    for (let i = 0; i < 520; i++) setHsBadgeEntry(`cap${i}`, 'ember')
    expect(getHsBadgeId('cap0')).toBeNull()
    expect(getHsBadgeId('cap519')).toBe('ember')
  })
})

describe('the mark', () => {
  test('is the catalogue glyph in its colour, titled "name — how"', () => {
    const html = renderHsBadgeToken('early_supporter')
    expect(html).toContain('class="hs-badge"')
    expect(html).toContain('style="color:#8888ff"')
    expect(html).toContain('data-badge="early_supporter"')
    expect(html).toContain('>●<')
    expect(html).toContain('early supporter — ')
    expect(hsBadgeTitle('ember')).toBe(`${EN.mc_badge_ember_label.message} — ${EN.mc_badge_ember_how.message}`)
  })

  test('is nothing for an id this build does not know, or for none', () => {
    for (const bad of ['plus_999m', '"><script>', null, undefined, '']) {
      expect(renderHsBadgeToken(bad), String(bad)).toBe('')
      expect(buildHsBadgeToken(bad), String(bad)).toBeNull()
    }
  })

  test('escapes the title it builds from translated words', () => {
    globalThis.t = () => '"><b>x</b>'
    const html = renderHsBadgeToken('staff')
    expect(html).not.toContain('"><b>')
    expect(html).toContain('&quot;&gt;&lt;b&gt;')
  })
})

describe('placement', () => {
  test('goes straight after the name, and after the plus mark when there is one', () => {
    const name = new El('hs-mc-user')
    placeHsBadgeToken(name, 'staff')
    expect(chain(name)).toEqual(['hs-mc-user', 'hs-badge:staff'])

    const name2 = new El('hs-mc-user')
    name2.insertAdjacentElement('afterend', new El('hs-plus-tenure'))
    placeHsBadgeToken(name2, 'staff')
    expect(chain(name2)).toEqual(['hs-mc-user', 'hs-plus-tenure', 'hs-badge:staff'])
  })

  test('a plus mark that lands later still ends up before the badge', () => {
    const name = new El('hs-mc-user')
    placeHsBadgeToken(name, 'staff')
    name.insertAdjacentElement('afterend', new El('hs-plus-tenure')) // what _placeHsPlusTenureToken does
    placeHsBadgeToken(name, 'staff')
    expect(chain(name)).toEqual(['hs-mc-user', 'hs-plus-tenure', 'hs-badge:staff'])
  })

  test('is idempotent, replaces a changed badge, and removes one that went away', () => {
    const name = new El('hs-mc-user')
    placeHsBadgeToken(name, 'ember')
    placeHsBadgeToken(name, 'ember')
    expect(chain(name)).toEqual(['hs-mc-user', 'hs-badge:ember'])
    placeHsBadgeToken(name, 'plus_6m')
    expect(chain(name)).toEqual(['hs-mc-user', 'hs-badge:plus_6m'])
    placeHsBadgeToken(name, null)
    expect(chain(name)).toEqual(['hs-mc-user'])
  })

  test('does nothing for a missing name', () => {
    expect(() => placeHsBadgeToken(null, 'staff')).not.toThrow()
  })
})

describe('words', () => {
  test('every catalogue badge has a label and a how in english', () => {
    for (const b of BADGES) {
      expect(EN[`mc_badge_${b.id}_label`]?.message, b.id).toBeTruthy()
      expect(EN[`mc_badge_${b.id}_how`]?.message, b.id).toBeTruthy()
    }
  })

  test('and in every locale, translated, lowercase-first, no raw key', () => {
    const locales = readdirSync(join(ROOT, 'src', '_locales'))
    expect(locales.length).toBe(34)
    for (const loc of locales) {
      const m = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', loc, 'messages.json'), 'utf8'))
      for (const b of BADGES) {
        for (const part of ['label', 'how']) {
          const v = m[`mc_badge_${b.id}_${part}`]?.message
          expect(v, `${loc} ${b.id} ${part}`).toBeTruthy()
          expect(v.startsWith('mc_badge_'), `${loc} ${b.id} ${part} is a raw key`).toBe(false)
        }
      }
    }
  })
})
