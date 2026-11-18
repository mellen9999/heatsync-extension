/**
 * Right-click a name and its hover card was still up: the pointer never left the name, the card
 * is drawn above everything and takes clicks, so it sat on the menu's items ("chat logs" could
 * not be clicked on kick and youtube, e2e s23, 11-17). Opening a menu now clears every hover tip,
 * and the name card does not come up under an open menu. ctx-menu.js and the tip hiders run for
 * real against a happy-dom page.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { t } from './en-t.js'

const read = (f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8')
const MENU = ['overlay-keys.js', 'ctx-menu.js'].map(read).join('\n')
const TIPS = read('tooltips.js')
const fnSrc = (name) => {
  const s = TIPS.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`carve: ${name}`)
  return TIPS.slice(s, TIPS.indexOf('\n}\n', s) + 3)
}

let win
afterEach(async () => {
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await win.happyDOM.close()
})

test('opening a menu clears the hover tips first, the name card included', () => {
  win = new Window({ width: 1000, height: 800 })
  const doc = win.document
  const tip = (id) => {
    const el = doc.createElement('div')
    el.id = id
    el.className = 'visible'
    doc.body.appendChild(el)
    return el
  }
  const user = tip('hs-user-tooltip')
  const emote = tip('hs-emote-tooltip')
  const badge = tip('hs-badge-tooltip')
  const link = tip('hs-link-tooltip')
  const seen = []
  const api = new Function(
    'document',
    'window',
    't',
    'HS_DIR',
    'userTooltip',
    'emoteTooltip',
    'badgeTooltip',
    'linkTooltip',
    'seen',
    `let _profileGen = 7, _userTooltipTarget = {}, _linkHoverUrl = 'https://x.y'
     const hsClearEmoteHighlights = () => seen.push('highlights')
     ${['hideBadgeTooltip', 'hideEmoteTooltip', 'hideLinkTooltip', 'hideUserTooltip', 'hideHoverTips'].map(fnSrc).join('\n')}
     ${MENU}
     return { showHsCtxMenu, gen: () => _profileGen, target: () => _userTooltipTarget, open: () => hsCtxOpen }`,
  )(doc, win, t, () => 'ltr', user, emote, badge, link, seen)

  api.showHsCtxMenu(10, 10, 'alice', [{ label: 'chat logs', fn() {} }])
  expect(doc.getElementById('hs-mc-msg-ctx')).not.toBe(null)
  for (const el of [user, emote, badge, link]) expect(el.classList.contains('visible')).toBe(false)
  // a lookup still in flight for the card is dropped too: its answer must not bring the card back
  expect(api.gen()).toBe(8)
  expect(api.target()).toBe(null)
  expect(seen).toEqual(['highlights'])
  expect(api.open()).not.toBe(null)
})

test('the menu still opens where no tips exist (a surface without tooltips.js)', () => {
  win = new Window({ width: 1000, height: 800 })
  const api = new Function('document', 'window', 't', 'HS_DIR', `${MENU}; return { showHsCtxMenu }`)(
    win.document,
    win,
    t,
    () => 'ltr',
  )
  api.showHsCtxMenu(10, 10, 'x', [{ label: 'copy', fn() {} }])
  expect(win.document.getElementById('hs-mc-msg-ctx')).not.toBe(null)
})

test('the name card does not come up under an open menu', () => {
  win = new Window()
  const head = TIPS.slice(TIPS.indexOf('async function showUserTooltip('))
  // the first thing it does, before it builds or shows anything
  expect(head).toMatch(
    /^async function showUserTooltip\([^)]*\) \{\n(?:\s*\/\/.*\n)*\s*if \(typeof hsCtxOpen !== 'undefined' && hsCtxOpen\) return\n/,
  )
})
