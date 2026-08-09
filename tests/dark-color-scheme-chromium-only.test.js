/**
 * declareDarkColorScheme must only ever stamp the host page on chromium.
 *
 * The stamp (ea0525e0, shipped 1.7.43) appends <meta name="color-scheme"
 * content="dark"> to the HOST document to stop chromium's force-dark from
 * double-inverting twitch/kick/youtube. It is a page-level declaration, so its
 * blast radius is the host's own canvas, form controls, scrollbars and
 * same-origin frames — not just our overlay.
 *
 * Gecko has no force-dark, so on firefox the stamp has zero upside and that
 * whole blast radius. A firefox reporter bisected the white-rectangle player to
 * exactly this commit (1.7.42 clean, 1.7.43 broken). cfbb08b scoped the
 * per-element color-scheme RULES and left this page-level stamp alone, which is
 * why the report survived 1.7.45-1.7.47.
 *
 * navigator.userAgentData is the gate: chromium-only, so absence means gecko or
 * webkit and we must not touch the host's head.
 *
 * Extraction mirrors tests/hashtag-in-url.test.js: slice the function source
 * out of styles.js and eval it against a fake dom.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STYLES_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'styles.js'), 'utf8')

const START = 'function declareDarkColorScheme()'
const fnStart = STYLES_SRC.indexOf(START)
if (fnStart === -1) throw new Error('declareDarkColorScheme not found in styles.js')
const FN_SRC = STYLES_SRC.slice(fnStart)

// Build a fake dom whose body background is `bg`, record any appended metas.
function harness({ chromium, bg, existingMeta = false }) {
  const appended = []
  const head = {
    querySelector: (sel) => (existingMeta && sel === 'meta[name="color-scheme"]' ? {} : null),
    appendChild: (node) => appended.push(node),
  }
  const doc = {
    head,
    body: { __bg: bg },
    documentElement: { __bg: 'rgba(0, 0, 0, 0)' },
    createElement: () => ({ name: '', content: '' }),
  }
  const globals = {
    navigator: chromium ? { userAgentData: { brands: [] } } : {},
    document: doc,
    getComputedStyle: (el) => ({ backgroundColor: el.__bg }),
    cleanup: { trackNode: (n) => n },
  }
  const names = Object.keys(globals)
  // eslint-disable-next-line no-new-func
  const run = new Function(...names, `${FN_SRC}\nreturn declareDarkColorScheme()`)
  run(...names.map((n) => globals[n]))
  return appended
}

describe('declareDarkColorScheme', () => {
  test('stamps a dark host on chromium — the behaviour ea0525e0 exists for', () => {
    const appended = harness({ chromium: true, bg: 'rgb(14, 14, 16)' })
    expect(appended.length).toBe(1)
    expect(appended[0].name).toBe('color-scheme')
    expect(appended[0].content).toBe('dark')
  })

  test('NEVER stamps on firefox, even on a dark host — the white-player regression', () => {
    const appended = harness({ chromium: false, bg: 'rgb(14, 14, 16)' })
    expect(appended).toEqual([])
  })

  test('leaves a light host alone on chromium — the declaration must not be a lie', () => {
    const appended = harness({ chromium: true, bg: 'rgb(255, 255, 255)' })
    expect(appended).toEqual([])
  })

  test('defers to a scheme the page already declares', () => {
    const appended = harness({ chromium: true, bg: 'rgb(14, 14, 16)', existingMeta: true })
    expect(appended).toEqual([])
  })

  test('the firefox gate is checked BEFORE any host dom is touched', () => {
    // A gate that ran after the querySelector/getComputedStyle probes would
    // still be correct in outcome but would keep reading the host on gecko.
    let touched = false
    const run = new Function(
      'navigator',
      'document',
      'getComputedStyle',
      'cleanup',
      `${FN_SRC}\nreturn declareDarkColorScheme()`,
    )
    run(
      {},
      {
        head: {
          querySelector: () => {
            touched = true
            return null
          },
          appendChild: () => {
            touched = true
          },
        },
        body: {},
        documentElement: {},
        createElement: () => ({}),
      },
      () => {
        touched = true
        return { backgroundColor: 'rgb(0,0,0)' }
      },
      { trackNode: (n) => n },
    )
    expect(touched).toBe(false)
  })
})
