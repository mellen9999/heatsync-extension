import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Two labels were cut on a real page (e2e s27, 11-18): the russian "report / gift a sub" row of
 * the right-click menu (one line, cut with … at the menu's 280px) and the greek "pick file"
 * button of a filter rule's sound (cut at 130px). Both only fit by luck of the font: a larger
 * chat font cut them in every language.
 */
const root = join(import.meta.dir, '..')
const CSS = readFileSync(join(root, 'src', 'multichat', 'styles', '09-tooltips-menus.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const SOUND = readFileSync(join(root, 'src', 'multichat', 'sound-ui.js'), 'utf8')

test('a menu label too long for the menu wraps: it is never cut', () => {
  const rule = CSS.match(/\.hs-mc-ctx \.hs-mc-em-label\s*\{([^}]*)\}/)?.[1]
  expect(rule).toBeTruthy()
  expect(rule).not.toMatch(/nowrap|ellipsis|overflow:\s*hidden/)
  expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
  // a flex child only wraps when it may shrink below its text
  expect(rule).toMatch(/min-width:\s*0/)
})

test('the pick-file button holds "pick file" whole in every language', () => {
  const style = SOUND.match(/data-fr-action="pick" style="([^"]*)"/)?.[1]
  expect(style).toBeTruthy()
  const cap = style.match(/max-width:\$\{SFX_PICK_CH\}ch/)
  expect(cap).toBeTruthy()
  const ch = Number(SOUND.match(/const SFX_PICK_CH = (\d+)/)?.[1])
  const dir = join(root, 'src', '_locales')
  let longest = 0
  for (const l of readdirSync(dir)) {
    const m = JSON.parse(readFileSync(join(dir, l, 'messages.json'), 'utf8')).mc_sfx_pick?.message
    if (m) longest = Math.max(longest, [...`♪ ${m}`].length)
  }
  expect(longest).toBeGreaterThan(8)
  // the button's own padding (2 × 6px) is about two characters at 13px
  expect(ch).toBeGreaterThanOrEqual(longest + 2)
})
