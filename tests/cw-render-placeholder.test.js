/**
 * cw placeholder render — processEmotes' imgHtmlRaw block (emotes.js).
 *
 * When an emote object carries `cw` (server filter stub — no url), the chat
 * render must emit the dashed-cyan placeholder span (class hs-mc-emote-cw,
 * data-cw + category as text content, NO <img>) instead of the normal emote
 * wrapper. Everything else must keep producing the img wrapper unchanged.
 *
 * Source-slice harness: the emote-branch body is extracted from
 * src/multichat/emotes.js via markers and evaluated with stubbed deps —
 * marker drift fails loudly (pattern: tests/native-emote-escape.test.js).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'
import { hsEmoteDimAttr } from './emote-rungs-src.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

const branchSrc = sliceBetween("const rawWord = word.indexOf('&')", '// Build the new item')
// Real own-toggle helper (HS_CW_SETTING_BY_CAT + hsOwnCwHiddenCat), so the
// own-cwCats path is tested against production logic, not a stub.
const helperSrc = sliceBetween('const HS_CW_SETTING_BY_CAT', 'function processEmotes(')

const renderEmoteHtml = new Function(
  'word',
  'emote',
  'channel',
  'overlayBaseName',
  'blockedEmoteNames',
  'blockedEmoteHashes',
  'inventoryEmotes',
  'channelEmoteCaches',
  'unescapeHtml',
  'escapeHtml',
  'getChatResUrl',
  'staticEmoteSrc',
  '_hsEmoteBoxW',
  '_hsEmoteOversize',
  'window',
  'getSetting',
  'isViewerEmote',
  'emoteIsBlocked',
  'hsEmoteDimAttr',
  // emoteFromInv is declared upstream of the carved slice in processEmotes
  // (provenance flag for data-inv); default false here — attribution has its
  // own coverage in emote-inventory-gate.test.js.
  `let emoteFromInv = false\n${helperSrc}\n${branchSrc}\nreturn imgHtmlRaw`,
)

function render(word, emote, overrides = {}) {
  return renderEmoteHtml(
    word,
    emote,
    'somechannel',
    null,
    overrides.blocked || new Set(),
    overrides.blockedHashes || new Set(),
    overrides.inventory || new Set(),
    {},
    unescapeHtml,
    escapeHtml,
    (u) => u,
    (u) => u,
    new Map(),
    () => 0,
    { _hsStaleEmotes: null },
    overrides.getSetting || (() => true),
    (name) => (overrides.inventory || new Set()).has(name),
    (name, e) =>
      (overrides.blocked || new Set()).has(name) ||
      !!(e?.hash && (overrides.blockedHashes || new Set()).has(String(e.hash))),
    hsEmoteDimAttr,
  )
}

const URL = 'https://cdn.heatsync.org/uploads/abc.webp'

describe('processEmotes — cw placeholder render', () => {
  test('cw stub renders the placeholder span: class, data-cw, category text, no img', () => {
    const html = render('BloodFest', { cw: 'gore', url: '', state: 'cw', source: 'heatsync' })
    expect(html).toContain('hs-mc-emote-cw')
    expect(html).toContain('data-cw="gore"')
    expect(html).toContain('>gore</span>')
    expect(html).not.toContain('<img')
  })

  test('placeholder keeps the emote name reachable via title/data-emote-name', () => {
    const html = render('BloodFest', { cw: 'sexual', url: '' })
    expect(html).toContain('data-emote-name="BloodFest"')
    expect(html).toContain('title="BloodFest"')
  })

  test('category is escaped in attribute and text position', () => {
    const html = render('Sneaky', { cw: '"><img src=x onerror=alert(1)>', url: '' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&quot;&gt;&lt;img')
  })

  test('normal emote (no cw) still renders the img wrapper unchanged', () => {
    const html = render('Kappa', { url: URL, state: 'global', source: '7tv', hash: 'h1' })
    expect(html).toContain('<img')
    expect(html).toContain('hs-state-global')
    expect(html).not.toContain('hs-mc-emote-cw')
  })

  test('non-string / empty cw falls through to the normal wrapper', () => {
    for (const cw of ['', 42, null]) {
      const html = render('Kappa', { url: URL, state: 'global', source: '7tv', cw })
      expect(html).toContain('<img')
      expect(html).not.toContain('hs-mc-emote-cw')
    }
  })
})

describe('processEmotes — own emotes honor the owner cw toggles (cwCats)', () => {
  const settings = (off) => (key) => !off.includes(key)

  test('own gore emote hides when viewer_show_gore is off', () => {
    const html = render(
      'BloodFest',
      { url: URL, state: 'owned', source: 'heatsync', cwCats: ['gore'] },
      { getSetting: settings(['viewer_show_gore']) },
    )
    expect(html).toContain('hs-mc-emote-cw')
    expect(html).toContain('data-cw="gore"')
    expect(html).not.toContain('<img')
  })

  test('own gore emote renders normally when the toggle is on', () => {
    const html = render(
      'BloodFest',
      { url: URL, state: 'owned', source: 'heatsync', cwCats: ['gore'] },
      { getSetting: settings([]) },
    )
    expect(html).toContain('<img')
    expect(html).not.toContain('hs-mc-emote-cw')
  })

  test('plural server cats map to singular setting keys (weapons→viewer_show_weapon)', () => {
    const html = render(
      'Gun',
      { url: URL, state: 'owned', cwCats: ['weapons'] },
      { getSetting: settings(['viewer_show_weapon']) },
    )
    expect(html).toContain('data-cw="weapons"')
  })

  test('multi-cat: first HIDDEN category labels the box', () => {
    const html = render(
      'Mixed',
      { url: URL, state: 'owned', cwCats: ['sexual', 'gore'] },
      { getSetting: settings(['viewer_show_gore']) },
    )
    expect(html).toContain('data-cw="gore"')
  })

  test('unknown category never hides (forward-compat)', () => {
    const html = render('Odd', { url: URL, state: 'owned', cwCats: ['newcat'] }, { getSetting: () => false })
    expect(html).toContain('<img')
  })
})

describe("processEmotes — the box is reserved from the emote's natural size", () => {
  const imgTag = (html) => html.match(/<img [^>]*>/)[0]

  test('an emote with a measured size carries width + height on its img', () => {
    const html = render('Wide', { url: URL, state: 'channel', source: 'heatsync', width: 256, height: 64 })
    expect(imgTag(html)).toContain(' width="256" height="64"')
  })

  test('no measured size → no attributes, exactly the img it always was', () => {
    const html = render('Plain', { url: URL, state: 'channel', source: 'heatsync' })
    expect(imgTag(html)).not.toContain('width=')
    expect(imgTag(html)).not.toContain('height=')
  })

  test('a half-known or hostile size is dropped, never written into the markup', () => {
    for (const bad of [
      { width: 256 },
      { width: 0, height: 64 },
      { width: '256" onerror="x', height: 64 },
      { width: 256.5, height: 64 },
      { width: 99999, height: 64 },
    ]) {
      const html = render('Bad', { url: URL, state: 'channel', source: 'heatsync', ...bad })
      expect(imgTag(html)).not.toContain('width=')
      expect(imgTag(html)).not.toContain('onerror')
    }
  })
})
