/**
 * Tests for highlightThreadRefsInHtml (src/multichat/main.js) — the chat-message
 * transform that turns a HeatSync thread reference like `>>55` into the feed's
 * yellow .hs-post-link span, so a ref reads the same in twitch/kick/youtube chat
 * as it does in the social feed. The click wiring (switchTab('feed') + openThread)
 * lives in buildMessageDiv and is verified in-browser; this covers the pure
 * string transform (regex, id padding/display, tag-skipping, escaping).
 *
 * Extraction mirrors tests/feed-quote-paint.test.js: slice the function source
 * out of main.js and eval it in isolation with escapeHtml provided as a global.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeHtml, outsideTags } from '../src/lib/utils.js'
import { mainSource } from './main-src.js'

globalThis.escapeHtml = escapeHtml
// these transforms skip whole <a>…</a> spans via the shared helper
globalThis.outsideTags = outsideTags

const MAIN_SRC = mainSource()

function sliceBetween(startMarker, endMarker) {
  const s = MAIN_SRC.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = MAIN_SRC.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return MAIN_SRC.slice(s, e)
}

const fnSrc = sliceBetween('function highlightThreadRefsInHtml(html) {', '\n// Scroll helper — reused by both')

const { highlightThreadRefsInHtml } = new Function(
  `function highlightThreadRefsInHtml(html) {${fnSrc.slice(fnSrc.indexOf('{') + 1)}\nreturn { highlightThreadRefsInHtml }`,
)()

describe('highlightThreadRefsInHtml — >>id thread references in chat', () => {
  test('escaped >>55 → yellow .hs-post-link span, padded data-id, stripped display', () => {
    const out = highlightThreadRefsInHtml('check &gt;&gt;55 out')
    expect(out).toContain('<span class="hs-post-link" data-id="000055" style="cursor:pointer">&gt;&gt;55</span>')
  })

  test('raw >> form also matches (belt-and-suspenders like the feed regex)', () => {
    const out = highlightThreadRefsInHtml('>>1x')
    expect(out).toContain('data-id="00001x"')
    expect(out).toContain('>&gt;&gt;1x</span>')
  })

  test('leading zeros stripped for display, preserved (padded) in the link id', () => {
    const out = highlightThreadRefsInHtml('&gt;&gt;00001x')
    expect(out).toContain('data-id="00001x"')
    expect(out).toContain('>&gt;&gt;1x</span>') // display strips leading zeros
  })

  test('multiple refs in one message', () => {
    const out = highlightThreadRefsInHtml('&gt;&gt;55 and &gt;&gt;7a')
    expect((out.match(/class="hs-post-link"/g) || []).length).toBe(2)
    expect(out).toContain('data-id="000055"')
    expect(out).toContain('data-id="00007a"')
  })

  test('does NOT rewrite >> inside a tag/attribute (skips odd split segments)', () => {
    const out = highlightThreadRefsInHtml('<img class="hs-mc-emote" alt="a&gt;&gt;b">')
    expect(out).not.toContain('hs-post-link')
    expect(out).toBe('<img class="hs-mc-emote" alt="a&gt;&gt;b">')
  })

  test('lone >> with no following word char is not matched', () => {
    const out = highlightThreadRefsInHtml('what &gt;&gt; even')
    expect(out).not.toContain('hs-post-link')
  })

  test('text without any > is returned unchanged (early out)', () => {
    const s = 'just a normal chat message'
    expect(highlightThreadRefsInHtml(s)).toBe(s)
  })

  test('caps the id at 6 word chars (feed convention)', () => {
    const out = highlightThreadRefsInHtml('&gt;&gt;abcdefg') // 7 chars
    // only the first 6 are captured as the id; the 7th stays as trailing text
    expect(out).toContain('data-id="abcdef"')
    expect(out).toContain('g')
  })
})
