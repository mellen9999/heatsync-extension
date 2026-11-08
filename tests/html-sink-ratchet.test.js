/**
 * Every place the extension turns a string into live HTML (innerHTML, outerHTML,
 * insertAdjacentHTML, createContextualFragment, DOMParser text/html, setHTMLUnsafe,
 * document.write, srcdoc) must build that string from constants and the escape helpers
 * only. tests/html-sinks.js reads the syntax tree and decides; this file freezes what it
 * could not prove and makes the number go one way.
 *
 *   - a NEW sink it cannot prove fails the suite: fix it (escapeHtml / Number() /
 *     textContent) rather than listing it
 *   - a sink that gets FIXED while still listed also fails: take it off the list, so the
 *     list only ever shrinks and the next regression cannot hide behind a stale count
 *
 * The list below is "reviewed, not provable by shape". Each entry says why it is
 * believed safe; none of them is a place to put new code.
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Window } from 'happy-dom'
import { paintNameHtmlFor } from '../src/lib/paint-spec.js'
import { stvPaintCss } from '../src/lib/stv-paint-css.js'
import { escapeHtml } from '../src/lib/utils.js'
import { buildIndex, createClassifier, findSinks, parseFiles } from './html-sinks.js'

const ROOT = join(import.meta.dir, '..')

/** built into dist/ or copied in by the build: not source, and rewritten on every build */
const GENERATED = new Set([
  'chrome/background.js',
  'chrome/multichat.js',
  'chrome/multichat-core.js',
  'chrome/emoji-data.iso.js',
  'chrome/emoji-data.main.js',
])

function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === '_locales' || name === 'data' || name === 'node_modules') continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.js')) out.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  for (const name of readdirSync(join(ROOT, 'chrome'))) {
    const p = join(ROOT, 'chrome', name)
    if (name.endsWith('.js') && statSync(p).isFile() && !GENERATED.has(`chrome/${name}`)) out.push(p)
  }
  return out.sort()
}

/**
 * file → number of sinks it still has that are not provably guarded.
 * FROZEN: it may only shrink.
 */
const ALLOWLIST = {
  // the shared profile card (lib/card-render.js hsCardHtml): escapes every field through the escapeHtml it is handed
  'src/multichat/tooltips.js': 1,
  'src/multichat/profile-card.js': 1,
  // archive lines: read as DATA through an inert <template> and rebuilt node by node (walk(tpl.content) is why it is not "read only")
  'src/multichat/chat-logs.js': 1,
  // a chat line's text: processEmotes(escapeHtml(text)) then the mention / hashtag wrappers (tests/process-emotes-hostile.test.js)
  'src/multichat/whispers.js': 1,
  'src/multichat/main-messages.js': 3, // the same text pipeline (m._renderedHtml) x2, and the feed-quote name link whose paint arrives as a parameter
  'src/multichat/main-tabs.js': 1,
  // server-built embed cards: every field escaped or run through sanitizeEmbedId / safeUrl before it reaches the tag
  'src/multichat/feed-embed.js': 1,
  // name-marks.js is vendored byte for byte; its ink / glyph come from hsMarksBar's fixed tables, its flair is escaped
  'src/multichat/name-marks-data.js': 1,
  // the settings panel: registry rows and locale text, no data from outside the extension
  'src/multichat/settings-ui.js': 1,
  // feed posts the server stores pre-escaped; the client neutralises any bare `<` again before use
  'src/multichat/social.js': 1,
  'chrome/chat-injector.js': 2,
}

const files = sourceFiles()
const parsed = parseFiles(files)
const index = buildIndex(parsed)

/** @type {Map<string, { total: number, bad: any[] }>} */
const found = new Map()
for (const [file, sf] of parsed) {
  // a fresh classifier per file: verdicts memoised for one file's frames must not decide another's
  const sinks = findSinks(sf, createClassifier(index))
  if (!sinks.length) continue
  found.set(relative(ROOT, file), { total: sinks.length, bad: sinks.filter((s) => !s.guarded) })
}

describe('html sink ratchet', () => {
  test('the scan can see: it covers the source tree and finds the sinks that are known to exist', () => {
    const total = [...found.values()].reduce((n, f) => n + f.total, 0)
    expect(files.length).toBeGreaterThan(120)
    expect(total).toBeGreaterThan(60)
    for (const f of ['src/multichat/main-messages.js', 'src/multichat/tooltips.js', 'chrome/chat-injector.js']) {
      expect(found.has(f)).toBe(true)
    }
  })

  test('no new sink builds HTML from anything it cannot prove safe', () => {
    const fresh = []
    for (const [file, { bad }] of found) {
      const allowed = ALLOWLIST[file] || 0
      if (bad.length <= allowed) continue
      for (const s of bad) {
        fresh.push(
          `${file}:${s.line} ${s.kind} ${s.text.replace(/\s+/g, ' ').slice(0, 80)}\n      ${s.why.slice(0, 2).join('\n      ')}`,
        )
      }
    }
    expect(
      fresh,
      `unguarded HTML sink(s). Build the string from escapeHtml()/Number()/constants, or write it with textContent / createElement:\n  ${fresh.join('\n  ')}`,
    ).toEqual([])
  })

  test('a sink that is fixed comes off the list (it only shrinks)', () => {
    const stale = []
    for (const [file, allowed] of Object.entries(ALLOWLIST)) {
      const actual = found.get(file)?.bad.length || 0
      if (actual < allowed)
        stale.push(`${file}: listed ${allowed}, ${actual} left — lower it${actual === 0 ? ' / delete the entry' : ''}`)
    }
    expect(stale, `fixed but still listed:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  test('every listed file exists and really has sinks', () => {
    for (const file of Object.keys(ALLOWLIST)) expect(found.has(file), `${file} has no html sinks`).toBe(true)
  })
})

// ── the classifier itself: legit shapes pass, the dangerous ones are caught ───────────

function classify(code, wrap = true) {
  const src = wrap ? `function f(el, x, data) {\n${code}\n}` : code
  const p = parseFiles(['t.js'], () => src)
  return findSinks(p.get('t.js'), createClassifier(buildIndex(p)))
}
const guarded = (code) => classify(code).map((s) => s.guarded)

describe('html sink classifier', () => {
  test('constants, escape helpers, numbers and i18n are guarded', () => {
    expect(guarded("el.innerHTML = '<b>' + escapeHtml(x) + '</b>'")).toEqual([true])
    expect(guarded('el.innerHTML = `<i title="${escapeHtml(x)}">${Number(data.n) || 0}</i>`')).toEqual([true])
    expect(guarded('el.innerHTML = `${t("k")}${data.items.length}`')).toEqual([true])
    expect(guarded("el.innerHTML = x ? '<a>' : '<b>'")).toEqual([true])
    expect(guarded('el.innerHTML = `<u>${safeUrl(x)}${sanitizeColor(x)}</u>`')).toEqual([true])
  })

  test('raw values are not', () => {
    expect(guarded("el.innerHTML = '<b>' + x + '</b>'")).toEqual([false])
    expect(guarded('el.innerHTML = `<i>${data.name}</i>`')).toEqual([false])
    expect(guarded('el.innerHTML = x')).toEqual([false])
    expect(guarded('el.innerHTML = `<i title="${x.y}">`')).toEqual([false])
    expect(guarded('el.innerHTML = String(x)')).toEqual([false])
    expect(guarded('el.innerHTML = x.replace(/a/g, "b")')).toEqual([false])
  })

  test('a string built up in steps is judged by every step', () => {
    expect(guarded("let h = '<b>'\nh += escapeHtml(x)\nel.innerHTML = h")).toEqual([true])
    expect(guarded("let h = '<b>'\nh += x\nel.innerHTML = h")).toEqual([false])
    expect(guarded('let h = escapeHtml(x)\nif (data) h = x\nel.innerHTML = h')).toEqual([false])
    expect(guarded('let n = 0\nn++\nn += 2\nel.innerHTML = `${n}`')).toEqual([true])
    expect(guarded("const parts = []\nparts.push(escapeHtml(x))\nel.innerHTML = parts.join('')")).toEqual([true])
    expect(guarded("const parts = []\nparts.push(x)\nel.innerHTML = parts.join('')")).toEqual([false])
  })

  test('a builder is guarded for the arguments it is actually called with', () => {
    const lib = (call) => `const row = (a) => '<td>' + a + '</td>'\nfunction f(el, x) {\n${call}\n}`
    expect(classify(lib("el.innerHTML = row('const')"), false).map((s) => s.guarded)).toEqual([true])
    expect(classify(lib('el.innerHTML = row(escapeHtml(x))'), false).map((s) => s.guarded)).toEqual([true])
    expect(classify(lib('el.innerHTML = row(x)'), false).map((s) => s.guarded)).toEqual([false])
  })

  test('a bundle-global `let` is judged by what any other file writes to it', () => {
    const run = (other) => {
      const srcs = { 'a.js': "let label = ''\nfunction f(el) { el.innerHTML = label }", 'b.js': other }
      const p = parseFiles(Object.keys(srcs), (f) => srcs[f])
      return findSinks(p.get('a.js'), createClassifier(buildIndex(p))).map((s) => s.guarded)
    }
    expect(run('function g() { label = escapeHtml(window.name) }')).toEqual([true])
    expect(run('function g(data) { label = data.name }')).toEqual([false])
    expect(run('function g(data) { label += data.name }')).toEqual([false])
    expect(run('function g(data) { const label = data.name; return label }')).toEqual([true])
  })

  test('a callback is judged with the arguments of the call chain it runs in, not the first one seen', () => {
    const lib = (calls) =>
      `function cells(rows, tag) { return rows.map((r) => '<td>' + tag + '</td>').join('') }\nfunction f(el, x) {\n${calls}\n}`
    const verdicts = (calls) => classify(lib(calls), false).map((s) => s.guarded)
    expect(verdicts("el.innerHTML = cells(x, 'b')\nel.innerHTML = cells(x, x)")).toEqual([true, false])
    expect(verdicts("el.innerHTML = cells(x, x)\nel.innerHTML = cells(x, 'b')")).toEqual([false, true])
  })

  test('an escape helper handed over by name is an escaper inside the callee', () => {
    const lib = (call) =>
      `function hk(label, esc) { return '<b>' + esc(label) + '</b>' }\nfunction f(el, x) {\n${call}\n}`
    const verdicts = (call) => classify(lib(call), false).map((s) => s.guarded)
    expect(verdicts('el.innerHTML = hk(x, escapeHtml)')).toEqual([true])
    expect(verdicts('el.innerHTML = hk(x, String)')).toEqual([false])
    expect(verdicts('el.innerHTML = hk(x, (s) => s)')).toEqual([false])
  })

  test('a builder that returns an object is judged property by property', () => {
    const lib = (read) =>
      `function parts(n) { return n ? { cls: 'a-' + escapeHtml(n), raw: n } : null }\nfunction f(el, x) {\nconst p = parts(x)\nel.innerHTML = ${read}\n}`
    expect(classify(lib('p ? p.cls : ""'), false).map((s) => s.guarded)).toEqual([true])
    expect(classify(lib('p ? p.raw : ""'), false).map((s) => s.guarded)).toEqual([false])
  })

  test('a global strip down to letters and digits is a guard, a partial strip is not', () => {
    expect(guarded("el.innerHTML = String(x).replace(/[^a-z0-9]/gi, '')")).toEqual([true])
    expect(guarded("el.innerHTML = String(x).replace(/[<>]/g, '')")).toEqual([false])
    expect(guarded("el.innerHTML = String(x).replace(/[^a-z0-9]/i, '')")).toEqual([false])
  })

  test('escapeHtml spelled out inline counts, in the right order only', () => {
    const chain = (...pairs) => pairs.map(([c, e]) => `.replace(/${c}/g, '${e}')`).join('')
    const all = [
      ['&', '&amp;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['"', '&quot;'],
    ]
    expect(guarded(`el.innerHTML = String(x)${chain(...all)}`)).toEqual([true])
    expect(guarded(`el.innerHTML = String(x)${chain(...all.slice(1), all[0])}`)).toEqual([false])
    expect(guarded(`el.innerHTML = String(x)${chain(...all.slice(0, 2))}`)).toEqual([false])
  })

  test('re-shaping a guarded string with guarded text stays guarded', () => {
    expect(guarded("el.innerHTML = escapeHtml(x).replace(/a/g, '<b>a</b>')")).toEqual([true])
    expect(guarded('el.innerHTML = escapeHtml(x).replace(/a/g, () => x)')).toEqual([false])
    expect(guarded('el.innerHTML = x.replace(/a/g, "<b>a</b>")')).toEqual([false])
  })

  test('a template parsed and only read back is inert; handed to the page it is not', () => {
    expect(
      guarded(
        "const t = document.createElement('template')\nt.innerHTML = x\nfor (const n of t.content.childNodes) n.textContent",
      ),
    ).toEqual([true])
    expect(guarded("const t = document.createElement('template')\nt.innerHTML = x\nel.appendChild(t.content)")).toEqual(
      [false],
    )
    expect(guarded("const t = document.createElement('template')\nt.innerHTML = x\nwalk(t.content)")).toEqual([false])
    expect(guarded("const t = document.createElement('div')\nt.innerHTML = x")).toEqual([false])
  })

  test('DOMParser is inert only when it is just asked a question', () => {
    expect(guarded("new DOMParser().parseFromString(x, 'text/html').querySelectorAll('img')")).toEqual([true])
    expect(guarded("el.append(new DOMParser().parseFromString(x, 'text/html').body)")).toEqual([false])
    expect(guarded("new DOMParser().parseFromString(x, 'text/xml')")).toEqual([])
  })

  test('every kind of sink is seen', () => {
    expect(classify('el.outerHTML = x').map((s) => s.kind)).toEqual(['outerHTML ='])
    expect(classify('el.innerHTML += x').map((s) => s.kind)).toEqual(['innerHTML +='])
    expect(classify("el.insertAdjacentHTML('beforeend', x)").map((s) => s.kind)).toEqual(['insertAdjacentHTML'])
    expect(classify('document.createRange().createContextualFragment(x)').map((s) => s.kind)).toEqual([
      'createContextualFragment',
    ])
    expect(classify('el.setHTMLUnsafe(x)').map((s) => s.kind)).toEqual(['setHTMLUnsafe'])
    expect(classify('document.write(x)').map((s) => s.kind)).toEqual(['write'])
    expect(classify('frame.srcdoc = x').map((s) => s.kind)).toEqual(['srcdoc ='])
    // the position argument of insertAdjacentHTML is not the markup
    expect(guarded("el.insertAdjacentHTML(x, '<b></b>')")).toEqual([true])
    // not sinks
    expect(classify('el.textContent = x; stream.write(x)')).toEqual([])
  })
})

// ── what the classifier trusts without reading, each with the real code run against hostile input ──

/** every way a parsed tree can run code */
function hazards(html) {
  const win = new Window()
  win.document.body.innerHTML = html
  const out = []
  for (const el of win.document.body.querySelectorAll('*')) {
    if (['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style'].includes(el.tagName.toLowerCase()))
      out.push(el.tagName)
    for (const a of el.attributes) if (/^on/i.test(a.name)) out.push(`${el.tagName}[${a.name}]`)
  }
  win.close?.()
  return out
}

describe('renderers the classifier trusts', () => {
  const HOSTILE = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    "'><svg onload=1>",
    '</span><img src=x onerror=1>',
    '&lt;b&gt;',
  ]
  const MODES = ['none', 'wrapped', 'letters', 'per-letter', 'scene']

  test('paintNameHtmlFor escapes whatever name and mode it is given', () => {
    for (const mode of MODES) {
      for (const name of HOSTILE) {
        expect({ mode, name, found: hazards(paintNameHtmlFor(name, mode)) }).toEqual({ mode, name, found: [] })
      }
    }
    expect(hazards(paintNameHtmlFor('<img src=x onerror=1>', 'letters')).length).toBe(0)
  })

  test('the hazard check bites', () => {
    expect(hazards('<img src=x onerror=1>')).toEqual(['IMG[onerror]'])
    expect(hazards('<b>ok</b>')).toEqual([])
  })
})

// ── regression: a paint's css carries double quotes and rides an attribute ─────────────

describe('paint css placed in a style attribute', () => {
  test('an image paint (url("…")) survives escapeHtml in the attribute; unescaped it truncates', () => {
    const style = stvPaintCss({ function: 'url', image_url: 'https://cdn.7tv.app/paint/abc/1x.webp' }).style
    expect(style).toContain('url("https://cdn.7tv.app/paint/abc/1x.webp")')
    const win = new Window()
    win.document.body.innerHTML = `<span id="a" style="${escapeHtml(style)}"></span><span id="b" style="${style}"></span>`
    expect(win.document.getElementById('a').getAttribute('style')).toBe(style)
    expect(win.document.getElementById('b').getAttribute('style')).not.toBe(style)
    win.close?.()
  })
})
