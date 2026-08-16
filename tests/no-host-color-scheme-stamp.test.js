/**
 * The extension must never stamp a page-level color-scheme on the host.
 *
 * History: ea0525e0 (1.7.43) appended <meta name="color-scheme" content="dark">
 * to the HOST document so chromium's force-dark would stop double-inverting
 * twitch/kick/youtube. A page-level declaration reaches the host's own canvas,
 * form controls, scrollbars AND the frames on the page — and a twitch overlay
 * extension is a frame stacked on the video player. Suppressing force-dark for
 * the page stops darkening that frame's light surface, which paints a white
 * rectangle over the whole video, appearing and disappearing exactly as the
 * extension is toggled. A firefox reporter bisected the same white player to
 * that commit (1.7.42 clean, 1.7.43 broken); 7c2f77e gated the stamp to
 * chromium, which fixed firefox and left every chromium user with it.
 *
 * The shield we actually need is per-element and lives in
 * styles/00-palette.css: `color-scheme: dark` on every hs- root, which force-
 * dark skips and which inherits through the whole overlay. That covers what we
 * render, and nothing we don't.
 *
 * This test is the tripwire. It has no function left to exercise — the point is
 * that no code path anywhere can put a color-scheme declaration on a page we do
 * not own.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

function sourceFiles() {
  const out = []
  for (const dir of [join(ROOT, 'src'), join(ROOT, 'chrome')]) {
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) {
          walk(p)
          continue
        }
        if (!name.endsWith('.js')) continue
        // chrome/multichat-*.js are build OUTPUT of src/multichat — checking
        // them would just report the same source twice, and a stale bundle
        // would fail a test about source intent.
        if (/^multichat-(twitch|kick|youtube)\.js$/.test(name)) continue
        out.push(p)
      }
    }
    walk(dir)
  }
  return out
}

describe('host page color-scheme', () => {
  test('finds the sources at all (guard against a walker that matches nothing)', () => {
    expect(sourceFiles().length).toBeGreaterThan(20)
  })

  test('nothing creates a color-scheme meta', () => {
    const offenders = []
    for (const file of sourceFiles()) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      // The stamp needs the name and the value; either alone is not it.
      if (/['"]color-scheme['"]/.test(src) && /meta/i.test(src)) {
        offenders.push(file.slice(ROOT.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })

  test('the per-element shield that replaced it is still in place', () => {
    const palette = readFileSync(join(ROOT, 'src', 'multichat', 'styles', '00-palette.css'), 'utf8')
    expect(palette).toContain('color-scheme: dark')
    // html/body must stay excluded: matching them is a page-level stamp wearing
    // a different hat — it would force the entire HOST out of auto-darkening.
    expect(palette).toContain(':not(html):not(body)')
  })
})
