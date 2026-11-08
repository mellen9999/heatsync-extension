/**
 * highlightHashtagsInHtml must never fire inside an already-linkified url.
 *
 * Reported live 2026-07-22 with a real archive permalink:
 *   https://heatsync.org/logs/twitch/nl_kripp/2026-07-22?m=<uuid>#mb812bf1a-46d8-…
 * The "#mb812bf1a" fragment is tag-shaped, so the hashtag pass wrapped it in
 * its own <a> — INSIDE the url's <a>. Nested anchors are invalid html5, so the
 * browser closes the outer link at that point: the fragment rendered magenta
 * and the rest of the url ("-46d8-…") fell out of the link as plain white text.
 *
 * The fix is the shared outsideTags helper, which skips whole <a>…</a> spans
 * rather than only tags. Same guard the partial-link pass already used.
 *
 * Extraction mirrors tests/thread-refs.test.js: slice the function source out
 * of main.js and eval it with its two helpers provided as globals.
 */

import { describe, expect, test } from 'bun:test'
import { escapeHtml, outsideTags } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

globalThis.escapeHtml = escapeHtml
globalThis.outsideTags = outsideTags

const MAIN_SRC = mainSource()

function sliceBetween(startMarker, endMarker) {
  const s = MAIN_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`start marker not found: ${startMarker}`)
  const e = MAIN_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(s, e)
}

const fnSrc = sliceBetween('function highlightHashtagsInHtml(html) {', '\n// Yellow >>id HeatSync thread')
const { highlightHashtagsInHtml } = new Function(
  `function highlightHashtagsInHtml(html) {${fnSrc.slice(fnSrc.indexOf('{') + 1)}\nreturn { highlightHashtagsInHtml }`,
)()

const A = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer" class="hs-mc-link">${text}</a>`
const NESTED_ANCHOR_RE = /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?<a\b/

describe('highlightHashtagsInHtml — never inside an existing link', () => {
  test('the reported url: the #fragment stays part of the link', () => {
    const url =
      'https://heatsync.org/logs/twitch/nl_kripp/2026-07-22?m=b812bf1a-46d8-4890-bbb5-c15c436a4b40#mb812bf1a-46d8-4890-bbb5-c15c436a4b40'
    const html = A(url, url)
    const out = highlightHashtagsInHtml(html)
    expect(out).toBe(html)
    expect(out).not.toMatch(NESTED_ANCHOR_RE)
    expect(out).not.toContain('hs-hashtag')
  })

  test('a bare #fragment-shaped token inside any anchor text is left alone', () => {
    const html = `${A('https://x.test/a#section', 'https://x.test/a#section')}`
    expect(highlightHashtagsInHtml(html)).toBe(html)
  })

  test('a real hashtag in ordinary text still becomes a magenta tag link', () => {
    const out = highlightHashtagsInHtml('big #kappa energy')
    expect(out).toContain('class="hs-hashtag"')
    expect(out).toContain('data-tag="kappa"')
    expect(out).toContain('>#kappa</a>')
  })

  test('a hashtag next to a link is still tagged — only the link itself is skipped', () => {
    const out = highlightHashtagsInHtml(`${A('https://x.test/a#b', 'https://x.test/a#b')} #kappa`)
    expect(out).toContain('class="hs-hashtag"')
    expect(out.match(/hs-hashtag/g)).toHaveLength(1)
    expect(out).not.toMatch(NESTED_ANCHOR_RE)
  })

  test('html entities still never read as tags (&#x27; is an apostrophe)', () => {
    expect(highlightHashtagsInHtml('it&#x27;s fine')).toBe('it&#x27;s fine')
  })
})
