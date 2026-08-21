/**
 * No inline `on*=` attribute in anything the extension injects into a host page.
 *
 * Twitch, Kick and YouTube all serve a script-src without 'unsafe-inline', so
 * an inline handler in injected markup is not merely bad practice — it never
 * runs, and it fails silently. The emote picker's error-state "retry" button
 * carried one, which meant the only way out of a failed emote load was to close
 * the panel and reopen it. The 'heatsync-retry' listener it dispatched to had
 * been wired the whole time; nothing was ever going to reach it.
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
        return statSync(f).isDirectory() ? walk(f) : /\.(js|html)$/.test(n) ? [f] : []
      })

// The three multichat-*.js in chrome/ are build output. popup.html is an
// extension page, governed by the manifest's own CSP, not a host page's — but
// that CSP forbids inline handlers too, so it stays in scope.
const FILES = [...walk('src'), ...walk('chrome')].filter((f) => !/multichat-(twitch|kick|youtube)\.js$/.test(f))

// ` onclick="` / ` onerror='` in markup. `el.onclick =` is a property
// assignment, not an attribute, and is unaffected by CSP.
const INLINE_ATTR = /\son[a-z]+\s*=\s*["'][^"']/gi

describe('injected markup', () => {
  test('scanned a real tree, so an empty pass is impossible', () => {
    expect(FILES.length).toBeGreaterThan(40)
    expect(FILES.some((f) => f.endsWith('chrome/heatsync-button.js'))).toBe(true)
  })

  test('recognises the shape it forbids', () => {
    expect(INLINE_ATTR.test('<button onclick="doThing()">go</button>')).toBe(true)
    INLINE_ATTR.lastIndex = 0
    expect(INLINE_ATTR.test('btn.onclick = doThing')).toBe(false)
    INLINE_ATTR.lastIndex = 0
  })

  test('no inline event handler attribute anywhere', () => {
    const offenders = []
    for (const f of FILES) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          INLINE_ATTR.lastIndex = 0
          if (INLINE_ATTR.test(line)) offenders.push(`${f}:${i + 1} — ${line.trim().slice(0, 90)}`)
        })
    }
    expect(offenders, 'host-page CSP refuses these; the handler never runs and nothing reports it').toEqual([])
  })
})
