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
    expect(src).toContain("typeof optionsOrLabel === 'string'")
    // And the runtime semantics this rule rests on:
    expect(Boolean('mc-picker-close')).toBe(true)
  })

  test('every capture listener says capture out loud', () => {
    const implicit = []
    for (const f of FILES) {
      for (const { line, parts } of calls(readFileSync(f, 'utf8'))) {
        const opts = parts[3]
        if (!opts) continue
        // A string is a label — fine, and the point of the fix. A boolean
        // literal `true` is capture without saying so; require the object form.
        if (opts === 'true') implicit.push(`${f}:${line} — bare \`true\`; write { capture: true }`)
      }
    }
    expect(implicit, 'capture has to be legible at the call site').toEqual([])
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
