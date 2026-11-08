/**
 * processEmotes is the one function every chat line's text goes through before it is
 * written with innerHTML, so the HTML-sink ratchet (html-sink-ratchet.test.js) treats its
 * output as safe exactly when its input is escaped. This is the proof that treatment rests
 * on: hostile text and hostile emote tables go in, and what comes out must parse to a tree
 * with no script, no event handler and no javascript: address.
 *
 * Same bundle-global stubs as emote-html-special-render.test.js.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import * as mods from '../src/lib/modifiers.js'
import { escapeHtml, unescapeHtml } from '../src/lib/utils.js'

// bun runs every test file in one global scope: put back what these stubs replaced when the file is done
const saved = new Map()
const stub = (key, value) => {
  if (!saved.has(key)) saved.set(key, key in globalThis ? { had: globalThis[key] } : null)
  globalThis[key] = value
}
afterAll(() => {
  for (const [key, was] of saved) {
    if (was) globalThis[key] = was.had
    else delete globalThis[key]
  }
})

stub('escapeHtml', escapeHtml)
stub('unescapeHtml', unescapeHtml)
stub('cleanup', { setIntervalIfVisible: () => {}, persistInterval: () => {} })
stub('HS_MOD_TOKENS', mods.HS_MOD_TOKENS)
stub('hsModClassify', mods.hsModClassify)
stub('hsModBuildStyleAttr', mods.hsModBuildStyleAttr)
stub('hsModInjectWrapperStyle', mods.hsModInjectWrapperStyle)
stub('hsModComposeFilter', mods.hsModComposeFilter)
stub('hsModHexToHue', mods.hsModHexToHue)
stub('hsModPeelChain', mods.hsModPeelChain)
stub('HS_MOD_C_HEX_RE', /^c!#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
stub('currentTab', 'chan-a')
stub('getCurrentChannel', () => 'chan-a')
stub('getLiveChannel', () => 'chan-a')
stub('linksEnabled', false)
stub('getSetting', () => undefined)
stub('sanitizeColor', (c) => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : '#ffffff'))
stub('knownColors', new Map())

const { processEmotes, emoteCache } = await import('../src/multichat/emotes.js')

const CDN = 'https://cdn.7tv.app/emote/01ABC/1x.webp'
const FRAGMENTS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg/onload=alert(1)>',
  "' onmouseover='alert(1)",
  '" onmouseover="alert(1)',
  '<a href="javascript:alert(1)">x</a>',
  'javascript:alert(1)',
  '&lt;img src=x onerror=1&gt;',
  '<iframe srcdoc="<script>1</script>">',
  '<style>*{background:url(javascript:1)}</style>',
  '</span><img src=x onerror=1>',
  '`${alert(1)}`',
]

/** every way a parsed tree can run code or load something nobody asked for */
function hazards(html) {
  const win = new Window()
  const doc = win.document
  doc.body.innerHTML = html
  const out = []
  for (const el of doc.body.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase()
    if (['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'base', 'form'].includes(tag))
      out.push(`<${tag}>`)
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) out.push(`${tag}[${a.name}]`)
      // an <img src> or a data-* attribute holding javascript: runs nothing; an address a click follows does
      const follows =
        ['href', 'action', 'formaction', 'xlink:href'].includes(a.name) || (a.name === 'src' && tag !== 'img')
      if (follows && /^\s*javascript:/i.test(a.value)) out.push(`${tag}[${a.name}=javascript:]`)
    }
  }
  win.close?.()
  return out
}

describe('processEmotes: hostile text and hostile emote tables stay inert', () => {
  test('the harness itself sees a handler when there is one', () => {
    expect(hazards('<img src=x onerror=1>')).toEqual(['img[onerror]'])
    expect(hazards('<a href="javascript:1">x</a>')).toEqual(['a[href=javascript:]'])
    expect(hazards('<script>1</script>')).toEqual(['<script>'])
    expect(hazards('<b>fine</b>')).toEqual([])
  })

  test('the check bites: the same call on text that was NOT escaped is caught, and the emote path really renders', () => {
    emoteCache.set('Kappa', { url: CDN, source: '7tv', state: 'global' })
    try {
      expect(processEmotes(escapeHtml('Kappa'), 'chan-x', null, null, null)).toContain('<img')
      const raw = processEmotes('<img src=x onerror=1> Kappa', 'chan-x', null, null, null)
      expect(hazards(raw)).toContain('img[onerror]')
    } finally {
      emoteCache.delete('Kappa')
    }
  })

  test('escaped hostile text comes out with no live hazard, with and without emotes in play', () => {
    emoteCache.set('Kappa', { url: CDN, source: '7tv', state: 'global' })
    try {
      for (const frag of FRAGMENTS) {
        for (const text of [frag, `Kappa ${frag} Kappa`, `@someone ${frag}`, `#tag ${frag}`]) {
          const out = processEmotes(escapeHtml(text), 'chan-x', null, null, null)
          expect({ text, found: hazards(out) }).toEqual({ text, found: [] })
        }
      }
    } finally {
      emoteCache.delete('Kappa')
    }
  })

  test('an emote whose name or url is hostile does not break out of its own tag', () => {
    const NAME = 'x"onerror="alert(1)'
    emoteCache.set(NAME, { url: CDN, source: '7tv', state: 'global' })
    emoteCache.set('BadUrl', { url: 'javascript:alert(1)', source: '7tv', state: 'global' })
    emoteCache.set('QuoteUrl', { url: `${CDN}"onerror="alert(1)`, source: '7tv', state: 'global' })
    try {
      for (const text of [NAME, 'BadUrl', 'QuoteUrl', `${NAME} BadUrl QuoteUrl`]) {
        const out = processEmotes(escapeHtml(text), 'chan-x', null, null, null)
        expect({ text, found: hazards(out) }).toEqual({ text, found: [] })
      }
    } finally {
      emoteCache.delete(NAME)
      emoteCache.delete('BadUrl')
      emoteCache.delete('QuoteUrl')
    }
  })
})
