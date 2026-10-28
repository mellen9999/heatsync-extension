/**
 * feed-embed.js — an embed whose media the server flagged is held behind the
 * viewer's own toggles, same default as the site: nothing opted in = held.
 *
 * Sliced from source so the test tracks the real functions, the way
 * img-proxy-rewrite.test.js does.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'feed-embed.js'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const s = SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return SRC.slice(s, e)
}

let on = new Set()
const getSetting = (k) => on.has(k)
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const held = sliceBetween('const HS_MEDIA_SETTING', '\nfunction _buildFeedResolvedHtml')
const { hsHeldMediaCat, _buildHeldEmbedHtml } = new Function(
  'getSetting',
  'attr',
  `${held}\nreturn { hsHeldMediaCat, _buildHeldEmbedHtml }`,
)(getSetting, attr)

beforeEach(() => {
  on = new Set()
})

describe('hsHeldMediaCat', () => {
  for (const [cat, key] of [
    ['nsfw', 'viewer_show_sexual'],
    ['violence', 'viewer_show_gore'],
    ['weapons', 'viewer_show_weapon'],
    ['drugs', 'viewer_show_drug'],
    ['hate', 'viewer_show_hate'],
  ]) {
    test(`${cat} is held until ${key} is on`, () => {
      expect(hsHeldMediaCat([cat])).toBe(cat)
      on.add(key)
      expect(hsHeldMediaCat([cat])).toBe('')
    })
  }

  test('opting in to one category does not release another', () => {
    on.add('viewer_show_sexual')
    expect(hsHeldMediaCat(['nsfw', 'drugs'])).toBe('drugs')
  })

  test('csam is held whatever is on', () => {
    for (const k of [
      'viewer_show_sexual',
      'viewer_show_gore',
      'viewer_show_weapon',
      'viewer_show_drug',
      'viewer_show_hate',
    ])
      on.add(k)
    expect(hsHeldMediaCat(['csam'])).toBe('csam')
  })

  test('clean or missing verdicts are not held', () => {
    expect(hsHeldMediaCat(undefined)).toBe('')
    expect(hsHeldMediaCat([])).toBe('')
    expect(hsHeldMediaCat(['spam'])).toBe('')
  })

  test('an unreadable setting holds rather than shows', () => {
    const f = new Function('getSetting', 'attr', `${held}\nreturn hsHeldMediaCat`)(undefined, attr)
    expect(f(['nsfw'])).toBe('nsfw')
  })
})

describe('held box', () => {
  test('is a one-line stub with the category and a show button', () => {
    const html = _buildHeldEmbedHtml('hate')
    expect(html).toContain('class="hs-mc-held"')
    expect(html).toContain('[embed hidden — hate speech]')
    expect(html).toContain('hs-mc-held-show')
  })

  test('is drawn as 2px dashed cyan', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'styles', '16-social-feed.css'), 'utf8')
    expect(css.match(/\.hs-mc-held\s*\{[^}]*\}/)?.[0]).toContain('border: 2px dashed #00ffff')
  })
})

describe('giphy, tenor and imgur resolve through the server', () => {
  test('none of them hotlinks an image or loads an iframe from the link', () => {
    for (const fn of ['giphyEmbed', 'tenorEmbed', 'imgurEmbed']) {
      const at = SRC.indexOf(`function ${fn}(`)
      const body = SRC.slice(at, SRC.indexOf('\n}\n', at))
      expect(body, fn).toContain('resolvedImageEmbed(')
      expect(body, fn).not.toMatch(/<iframe|<img/)
    }
  })
})
