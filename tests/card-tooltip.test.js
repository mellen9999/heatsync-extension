/**
 * The hover tooltip (src/multichat/tooltips.js renderProfileCard) is the
 * first extension surface migrated onto the shared card model/renderer
 * mirrored from the site (src/lib/card-{model,render,time}.js — see
 * tests/site-copy-parity.test.js). This pins:
 *   1. renderProfileCard actually calls hsCardModel + hsCardHtml('peek'),
 *      not a hand-rolled re-implementation.
 *   2. every OLD .hs-pc-* card class this file used to emit for a profile
 *      hover is gone (grep assertion — "old card code gone", house pattern).
 *   3. the ext-only progressive-enhancement primitive (hsExtUpsertSheetRow)
 *      that layers followage/sub-tenure onto the shared render's own
 *      .hs-card-sheet behaves correctly: create, update-in-place, dedupe.
 *
 * renderProfileCard is pure (string in, string out) — no DOM needed.
 * hsExtUpsertSheetRow mutates a live element, so it runs against a hand-built
 * DOM (house pattern for leaf files with no jsdom/happy-dom in this repo —
 * see tests/paint-fill-layers-mount.test.js's own note).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hsCardModel } from '../src/lib/card-model.js'
import { hsCardHtml } from '../src/lib/card-render.js'
import { escapeHtml } from '../src/lib/utils.js'

const ROOT = join(import.meta.dir, '..')
const TIPS = readFileSync(join(ROOT, 'src', 'multichat', 'tooltips.js'), 'utf8')

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  if (start === -1) throw new Error(`marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return src.slice(start, end)
}

// hsExtRenderBio + renderProfileCard, evaluated for real against the real
// (imported) hsCardModel/hsCardHtml — only escapeHtml/formatCompact are
// stand-ins for globals tooltips.js gets from the concatenated bundle scope.
const cardSrc = slice(TIPS, 'function hsExtRenderBio(text) {', '\nfunction hsExtUpsertSheetRow(')
const formatCompactSrc = slice(TIPS, 'function formatCompact(n) {', '\nfunction hsExtRenderBio(')
const { renderProfileCard, hsExtRenderBio } = new Function(
  'escapeHtml',
  'hsCardModel',
  'hsCardHtml',
  `${formatCompactSrc}\n${cardSrc}\nreturn { renderProfileCard, hsExtRenderBio }`,
)(escapeHtml, hsCardModel, hsCardHtml)

const upsertSrc = slice(
  TIPS,
  'function hsExtUpsertSheetRow(sheetEl, key, label, value, tone) {',
  '\n\n// Async banner fetch',
)

const PROFILE = {
  id: 42,
  username: 'testuser',
  display_name: 'TestUser',
  twitch_username: 'testuser',
  twitch_user_id: '123',
  twitch_created_at: '2018-01-01T00:00:00Z',
  twitch_broadcaster_type: 'affiliate',
  bio: 'hello @friend check #tag',
  color: '#ff8700',
  stats: { user_heat: 500, op_count: 10, re_count: 2, mop_count: 0, followers: 900 },
}

describe('renderProfileCard runs through the shared card pipeline', () => {
  test('output is the shared peek card, not a hand-rolled one', () => {
    const html = renderProfileCard(PROFILE, 'twitch')
    expect(html).toContain('hs-card hs-card-peek')
    expect(html).toContain('hs-card-identity')
    expect(html).toContain('hs-card-sheet')
    expect(html).toContain('TestUser')
  })

  test('no OLD .hs-pc-* profile-card classes remain in the emitted markup', () => {
    const html = renderProfileCard(PROFILE, 'twitch')
    expect(html).not.toMatch(/hs-pc-(hero|body|info|header|name|sheet|avatar|bio|pronoun)\b/)
  })

  test('bio autolinking still runs through the shared renderBio hook', () => {
    const html = renderProfileCard(PROFILE, 'twitch')
    expect(html).toContain('hs-card-bio-mention')
    expect(html).toContain('data-username="friend"')
    expect(html).toContain('hs-card-bio-tag')
  })

  test('a heat/type/age row renders via the shared sheet, not a bespoke one', () => {
    const html = renderProfileCard(PROFILE, 'twitch')
    expect(html).toContain('data-tone="affiliate"')
    expect(html).toContain('data-tone="heat-')
  })

  test('a chatter with no heatsync account still renders something (kind: chatter)', () => {
    const html = renderProfileCard({}, 'kick')
    // hsCardModel({profile:null}, ...) never happens here — renderProfileCard
    // always has SOME payload.profile — this pins that an empty/malformed
    // profile object degrades to the empty-card shell, never throws.
    expect(html).toContain('hs-card')
  })

  test('hsExtRenderBio is the one bio autolinker this file uses', () => {
    const html = hsExtRenderBio('@friend #tag plain text')
    expect(html).toContain('hs-card-bio-mention')
    expect(html).toContain('hs-card-bio-tag')
    expect(html).toContain('plain text')
  })
})

describe('formatSubTenure/getCompactRelTime are gone — one time formatter now', () => {
  test('tooltips.js no longer defines its own relative-time/tenure formatter', () => {
    expect(TIPS).not.toMatch(/\bfunction formatSubTenure\(/)
    expect(TIPS).not.toMatch(/\bfunction getCompactRelTime\(/)
  })
  test('the ext-only enhancers use the shared card-time.js formatters', () => {
    expect(TIPS).toContain('hsCardTenureMonths(months)')
    expect(TIPS).toContain('hsCardRelativeTime(result.followedAt)')
    expect(TIPS).toContain('hsCardRelativeTime(result.channelFollowedAt)')
  })
})

// ── minimal hand-built DOM — just enough for hsExtUpsertSheetRow's own
// query shapes (`.hs-card-sheet-row dd[data-k="x"]`, `.closest('.hs-card-sheet-row')`) ──
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    parentNode: null,
    _text: '',
    get textContent() {
      return this._text
    },
    set textContent(v) {
      this._text = v
    },
    appendChild(child) {
      child.parentNode = el
      el.children.push(child)
      return child
    },
    querySelector(sel) {
      // `.cls tag[data-k="x"]` is a DESCENDANT combinator — the class belongs
      // to an ANCESTOR of the matched node (the sheet-ROW div), never to the
      // node itself (the dd).
      const m = sel.match(/^(?:\.([\w-]+)\s+)?([a-z]+)\[data-k="([^"]+)"\]$/)
      if (!m) throw new Error(`unsupported selector in test stub: ${sel}`)
      const [, cls, tagName, key] = m
      const hasAncestorClass = (node) => {
        let p = node.parentNode
        while (p) {
          if ((p.className || '').split(' ').includes(cls)) return true
          p = p.parentNode
        }
        return false
      }
      const stack = [...el.children]
      while (stack.length) {
        const node = stack.shift()
        if (node.tagName.toLowerCase() === tagName && node.dataset?.k === key && (!cls || hasAncestorClass(node))) {
          return node
        }
        stack.push(...node.children)
      }
      return null
    },
    closest(sel) {
      const cls = sel.replace(/^\./, '')
      let node = el
      while (node) {
        if ((node.className || '').split(' ').includes(cls)) return node
        node = node.parentNode
      }
      return null
    },
  }
  return el
}

describe('hsExtUpsertSheetRow — the ext-only sheet-row enhancer', () => {
  const fakeDocument = { createElement: makeEl }
  const factory = new Function('document', `${upsertSrc}\nreturn hsExtUpsertSheetRow`)
  const hsExtUpsertSheetRowStub = factory(fakeDocument)

  test("creates a row shaped like renderSheet's own rows", () => {
    const sheet = makeEl('dl')
    hsExtUpsertSheetRowStub(sheet, 'ch-follow', 'ch follow', 'somechannel 3y', 'ch')
    expect(sheet.children.length).toBe(1)
    const row = sheet.children[0]
    expect(row.className).toBe('hs-card-sheet-row')
    expect(row.dataset.tone).toBe('ch')
    const [dt, dd] = row.children
    expect(dt.tagName).toBe('DT')
    expect(dt.textContent).toBe('ch follow')
    expect(dd.tagName).toBe('DD')
    expect(dd.dataset.k).toBe('ch-follow')
    expect(dd.textContent).toBe('somechannel 3y')
  })

  test('a second call with the same key updates in place, never duplicates', () => {
    const sheet = makeEl('dl')
    hsExtUpsertSheetRowStub(sheet, 'followers', 'followers', '1.0k', 'followers')
    hsExtUpsertSheetRowStub(sheet, 'followers', 'followers', '1.2k', 'followers')
    expect(sheet.children.length).toBe(1)
    expect(sheet.children[0].children[1].textContent).toBe('1.2k')
  })

  test('updating an existing row can change its tone (not-following → following)', () => {
    const sheet = makeEl('dl')
    hsExtUpsertSheetRowStub(sheet, 'ch-follow', 'ch follow', 'not following x', 'dim')
    hsExtUpsertSheetRowStub(sheet, 'ch-follow', 'ch follow', 'x 2d', 'ch')
    expect(sheet.children[0].dataset.tone).toBe('ch')
  })

  test('no-op on a missing sheet element', () => {
    expect(() => hsExtUpsertSheetRowStub(null, 'k', 'l', 'v', 't')).not.toThrow()
  })
})
