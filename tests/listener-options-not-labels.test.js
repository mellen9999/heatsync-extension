/**
 * A string in cleanup.addEventListener's options slot is a LABEL, and a label
 * must not silently become `capture: true`.
 *
 * Twenty-two call sites passed one — 'mc-picker-close', 'emote-click',
 * 'input-modifier-backspace' — copying the habit from cleanup.setTimeout,
 * which really does take a trailing label. Web IDL resolves a string against
 * `boolean | AddEventListenerOptions`: it is not an object, so it converts to
 * boolean, and a non-empty string is true. Every one of those listeners ran in
 * the capture phase, ahead of the host page's own handlers, and nothing said
 * so. Nothing ever will: capture is not observable from the call site.
 *
 * Five listeners genuinely need capture and now say so with an explicit
 * `{ capture: true }` — the four that stopPropagation to preempt Twitch, and
 * the `error` listener on document.body, since error events do not bubble and
 * a delegated bubble-phase handler would never see a failed <img> at all.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const walk = (d) =>
  !existsSync(d)
    ? []
    : readdirSync(d).flatMap((n) => {
        if (n === 'node_modules' || n.startsWith('.') || n === 'dist') return []
        const f = join(d, n)
        return statSync(f).isDirectory() ? walk(f) : n.endsWith('.js') ? [f] : []
      })

// The three multichat-*.js in chrome/ are build output, not source.
const FILES = [...walk('src'), ...walk('chrome')].filter((f) => !/multichat-(twitch|kick|youtube)\.js$/.test(f))

/** Every cleanup.addEventListener call, with its arguments split at top level. */
function calls(src) {
  const out = []
  const NEEDLE = 'cleanup.addEventListener('
  let i = src.indexOf(NEEDLE)
  while (i >= 0) {
    const start = i + NEEDLE.length - 1
    let depth = 0
    let j = start
    for (; j < src.length; j++) {
      const c = src[j]
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) break
    }
    const args = src.slice(start + 1, j)
    const parts = []
    let d = 0
    let last = 0
    for (let k = 0; k < args.length; k++) {
      const c = args[k]
      if ('([{'.includes(c)) d++
      else if (')]}'.includes(c)) d--
      else if (c === ',' && d === 0) {
        parts.push(args.slice(last, k))
        last = k + 1
      }
    }
    parts.push(args.slice(last))
    out.push({ line: src.slice(0, i).split('\n').length, parts: parts.map((p) => p.trim()) })
    i = src.indexOf(NEEDLE, j)
  }
  return out
}

describe('cleanup.addEventListener', () => {
  test('scanned a real tree, so an empty pass is impossible', () => {
    expect(FILES.length).toBeGreaterThan(40)
    const total = FILES.reduce((n, f) => n + calls(readFileSync(f, 'utf8')).length, 0)
    expect(total).toBeGreaterThan(20)
  })

  test('treats a string in the options slot as a label, not as capture', () => {
    const src = readFileSync('src/lib/cleanup.js', 'utf8')
    // The implementation has to make the distinction explicitly; there is no
    // way to observe capture from outside, so the source IS the assertion.
    expect(src).toContain("const aIsLabel = typeof a === 'string'")
    // And the runtime semantics this rule rests on:
    expect(Boolean('mc-picker-close')).toBe(true)
  })

  test('every capture listener says capture out loud, in either slot', () => {
    const implicit = []
    for (const f of FILES) {
      for (const { line, parts } of calls(readFileSync(f, 'utf8'))) {
        // BOTH trailing slots, not just the fourth. Two calls in content.js
        // read `(document, 'mouseover', fn, 'emote-hover-mouseover', true)` —
        // label first, capture second — and a check that only looked at the
        // fourth argument could not see the `true` at all. Those two are
        // delegates that must beat Twitch's own hover handlers, so losing
        // capture there is a real behaviour change with no visible symptom.
        for (const slot of [parts[3], parts[4]]) {
          if (slot === 'true' || slot === 'false') {
            implicit.push(`${f}:${line} — bare \`${slot}\`; write { capture: ${slot} }`)
          }
        }
      }
    }
    expect(implicit, 'capture has to be legible at the call site').toEqual([])
  })

  test('a label and options survive together, in either order', () => {
    // The signature has to sort them by type. Reading position alone drops one
    // of them, and which one it drops depends on the call site.
    const src = readFileSync('src/lib/cleanup.js', 'utf8')
    expect(src).toContain("typeof b === 'string'")
    // The MAIN-world copy in autocomplete-hook.js keeps its own lifecycle
    // object and needs the same reading, or a call written for the shared one
    // silently loses its capture flag there.
    expect(readFileSync('chrome/autocomplete-hook.js', 'utf8')).toContain("const aIsLabel = typeof a === 'string'")
  })

  test('the five listeners that need capture still have it', () => {
    const need = [
      ['chrome/autocomplete-hook.js', 'image-error-handler'],
      ['chrome/content.js', 'input-modifier-backspace'],
      ['chrome/content.js', 'emote-click'],
      ['chrome/content.js', 'native-twitch-block-contextmenu'],
      ['chrome/content.js', 'emote-contextmenu'],
    ]
    for (const [file, label] of need) {
      const src = readFileSync(file, 'utf8')
      const at = src.indexOf(`'${label}'`)
      expect(at, `${file}: ${label} is gone`).toBeGreaterThan(0)
      // { capture: true } must sit in the same call, just before the label.
      const window_ = src.slice(Math.max(0, at - 400), at)
      expect(window_, `${file}: ${label} lost its explicit capture`).toContain('{ capture: true }')
    }
  })
})
