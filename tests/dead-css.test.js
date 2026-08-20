import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A class defined in CSS that nothing ever applies is dead weight shipped to
 * every user, and it accumulates silently because removing a feature rarely
 * removes its styling.
 *
 * When this was written the overlay had 855 class selectors and exactly ONE
 * dead rule. That is the state worth ratcheting: the cost of holding it is
 * nothing, and the alternative is finding out years later.
 *
 * Two things this must NOT flag, both learned by getting them wrong first:
 *  - a first cut searched a corpus that INCLUDED the stylesheets, so every
 *    class matched itself and it reported a clean 0 out of 855. It proved
 *    nothing. The corpus here is code and markup only.
 *  - ~75 classes are built at runtime from a prefix (`hs-fx-${name}`,
 *    `hs-state-` + kind). Those never appear whole in source and are alive.
 */

const STYLES = join(import.meta.dir, '..', 'src', 'multichat', 'styles')
const ROOT = join(import.meta.dir, '..')
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Classes belonging to the HOST pages we restyle — twitch/kick markup we target
 * but never author, so of course our code never applies them.
 */
const HOST_PAGE = [
  'tw-',
  'sunlight-',
  'channel-root',
  'channel-leaderboard',
  'persistent-player',
  'pinned-callout',
  'root-scrollable',
  'supporter',
  'chat-line',
  'chat-list',
  'chat-shell',
  'stream-chat',
  'chat-room',
  'chat-input',
  'chat-author',
  'chatroom',
  'editor-input',
  'video-player',
  'top-nav',
  'side-nav',
  'right-column',
]

function definedClasses() {
  let css = ''
  for (const f of readdirSync(STYLES).filter((x) => x.endsWith('.css'))) {
    css += stripComments(readFileSync(join(STYLES, f), 'utf8'))
  }
  return new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]{2,})/g)].map((m) => m[1]))
}

/** Everywhere a class could actually be APPLIED. Never the stylesheets. */
function codeCorpus() {
  const out = []
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) {
        if (f.name !== 'node_modules' && f.name !== 'styles' && f.name !== '_locales') walk(join(dir, f.name))
        continue
      }
      if (!/\.(js|html)$/.test(f.name)) continue
      if (/^multichat-(twitch|kick|youtube)\.js$/.test(f.name)) continue // build output
      out.push(readFileSync(join(dir, f.name), 'utf8'))
    }
  }
  walk(join(ROOT, 'src'))
  walk(join(ROOT, 'chrome'))
  return out.join('\n')
}

describe('dead css', () => {
  const defined = definedClasses()
  const corpus = codeCorpus()
  const literals = new Set(corpus.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g) || [])

  test('the analysis actually reads both sides', () => {
    expect(defined.size).toBeGreaterThan(600)
    expect(literals.size).toBeGreaterThan(2000)
  })

  test('no class is defined that nothing can ever apply', () => {
    const dead = []
    for (const c of defined) {
      if (literals.has(c)) continue
      if (HOST_PAGE.some((p) => c.startsWith(p))) continue
      // built at runtime from a prefix?
      const parts = c.split('-')
      let built = false
      for (let i = parts.length - 1; i > 0; i--) {
        const pre = `${parts.slice(0, i).join('-')}-`
        if (
          corpus.includes(`\`${pre}`) ||
          new RegExp(`${pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\$\\{|'|"|\`)`).test(corpus)
        ) {
          built = true
          break
        }
      }
      if (!built) dead.push(c)
    }
    expect(dead, 'defined in css, never applied by any code or markup — delete the rule').toEqual([])
  })
})
