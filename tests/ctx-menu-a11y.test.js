/**
 * The right-click menu is a real ARIA menu you can drive without a mouse: roles,
 * a name, real focus that goes in on open and back out on close, arrows / home /
 * end / enter / the numbered shortcuts, and a hands-off rule for modified keys
 * (alt+1 is "go to tab 1", it must never also fire item 1 of an open menu).
 * ctx-menu.js runs for real against a happy-dom page.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { t } from './en-t.js'

// overlay-keys.js rides along: the menu hands every key it consumes to ownKeyup
const SRC = ['overlay-keys.js', 'ctx-menu.js']
  .map((f) => readFileSync(join(import.meta.dir, '..', 'src', 'multichat', f), 'utf8'))
  .join('\n')

let win
let doc
let api
let fired
let ctl

const tick = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  win = new Window({ width: 1000, height: 800 })
  doc = win.document
  doc.body.innerHTML = '<button id="opener">row</button><input id="other">'
  fired = []
  api = new Function(
    'document',
    'window',
    't',
    'HS_DIR',
    `${SRC}; return { showHsCtxMenu, initOwnedKeyups, open: () => hsCtxOpen }`,
  )(doc, win, t, () => 'ltr')
  ctl = new AbortController()
  api.initOwnedKeyups(ctl.signal)
})
afterEach(async () => {
  ctl.abort()
  // closes whatever a test left open, so its document listeners never leak into the next
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await win.happyDOM.close()
})

const items = () => [
  { label: 'reply', fn: () => fired.push('reply') },
  { label: 'copy', fn: () => fired.push('copy') },
  'sep',
  { label: 'ban', danger: true, fn: () => fired.push('ban') },
  { label: 'nope', disabled: true, fn: () => fired.push('nope') },
]
const menu = () => doc.getElementById('hs-mc-msg-ctx')
const rows = () => [...menu().querySelectorAll('[role="menuitem"]')]
const press = (key, init = {}) => {
  const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  doc.dispatchEvent(ev)
  return ev
}
const open = async (opts, header = 'alice') => {
  doc.getElementById('opener').focus()
  api.showHsCtxMenu(10, 10, header, items(), opts)
  await tick()
}

describe('what a screen reader is told', () => {
  test('a menu with a name, menuitems, and a separator', async () => {
    await open({ keyboard: true })
    expect(menu().getAttribute('role')).toBe('menu')
    expect(menu().getAttribute('aria-label')).toBe('actions for alice')
    expect(rows().map((r) => r.getAttribute('role'))).toEqual(['menuitem', 'menuitem', 'menuitem', 'menuitem'])
    expect(menu().querySelector('[role="separator"]')).toBeTruthy()
  })

  test('no header: it still has a name', async () => {
    await open({ keyboard: true }, '')
    expect(menu().getAttribute('aria-label')).toBe('actions')
  })

  test('the header is not read twice, the digit hint is not part of an item name', async () => {
    await open({ keyboard: true })
    expect(menu().querySelector('.hs-mc-em-header').getAttribute('aria-hidden')).toBe('true')
    for (const r of rows().slice(0, 3)) {
      expect(r.querySelector('.hs-mc-em-kbd').getAttribute('aria-hidden')).toBe('true')
      expect(r.getAttribute('aria-keyshortcuts')).toMatch(/^[1-3]$/)
    }
  })

  test('a disabled item says so and carries no shortcut', async () => {
    await open({ keyboard: true })
    const last = rows()[3]
    expect(last.getAttribute('aria-disabled')).toBe('true')
    expect(last.getAttribute('aria-keyshortcuts')).toBeNull()
    expect(last.querySelector('.hs-mc-em-kbd')).toBeNull()
    expect(rows()[0].getAttribute('aria-disabled')).toBeNull()
  })
})

describe('focus', () => {
  test('opened from the keyboard: the first usable item holds focus', async () => {
    await open({ keyboard: true })
    expect(doc.activeElement).toBe(rows()[0])
  })

  test('opened with a mouse: the menu holds focus, no item is lit under a pointer elsewhere', async () => {
    await open({})
    expect(doc.activeElement).toBe(menu())
    expect(rows().some((r) => r === doc.activeElement)).toBe(false)
  })

  test('closing puts focus back on what had it', async () => {
    await open({ keyboard: true })
    press('Escape')
    expect(menu()).toBeNull()
    expect(doc.activeElement).toBe(doc.getElementById('opener'))
  })

  test('using an item closes the menu and returns focus first, so an item that moves focus itself wins', async () => {
    let seen = null
    doc.getElementById('opener').focus()
    api.showHsCtxMenu(10, 10, 'alice', [{ label: 'go', fn: () => (seen = doc.activeElement) }], { keyboard: true })
    await tick()
    press('Enter')
    expect(seen).toBe(doc.getElementById('opener'))
  })

  test('a second menu over the first keeps the ORIGINAL opener', async () => {
    await open({ keyboard: true })
    api.showHsCtxMenu(20, 20, 'bob', items(), { keyboard: true })
    await tick()
    expect(doc.querySelectorAll('#hs-mc-msg-ctx').length).toBe(1)
    press('Escape')
    expect(doc.activeElement).toBe(doc.getElementById('opener'))
  })
})

describe('keys', () => {
  test('arrows move between items and wrap', async () => {
    await open({ keyboard: true })
    press('ArrowDown')
    expect(doc.activeElement).toBe(rows()[1])
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    expect(doc.activeElement).toBe(rows()[0])
    press('ArrowUp')
    expect(doc.activeElement).toBe(rows()[3])
  })

  test('home and end jump to the ends', async () => {
    await open({ keyboard: true })
    press('End')
    expect(doc.activeElement).toBe(rows()[3])
    press('Home')
    expect(doc.activeElement).toBe(rows()[0])
  })

  test('arrow-down on a mouse-opened menu lands on the first item, arrow-up on the last', async () => {
    await open({})
    press('ArrowDown')
    expect(doc.activeElement).toBe(rows()[0])
    press('Escape')
    await open({})
    press('ArrowUp')
    expect(doc.activeElement).toBe(rows()[3])
  })

  test('enter uses the focused item; space does too', async () => {
    await open({ keyboard: true })
    press('ArrowDown')
    press('Enter')
    expect(fired).toEqual(['copy'])
    expect(menu()).toBeNull()
    await open({ keyboard: true })
    press(' ')
    expect(fired).toEqual(['copy', 'reply'])
  })

  test('enter on a disabled item does nothing and keeps the menu open', async () => {
    await open({ keyboard: true })
    press('End')
    press('Enter')
    expect(fired).toEqual([])
    expect(menu()).not.toBeNull()
  })

  test('the digits still fire the nth USABLE item', async () => {
    await open({ keyboard: true })
    press('3')
    expect(fired).toEqual(['ban'])
    await open({ keyboard: true })
    press('4') // the disabled one has no number
    expect(fired).toEqual(['ban'])
    expect(menu()).not.toBeNull()
  })

  test('handled keys are swallowed so the page behind never sees them', async () => {
    await open({ keyboard: true })
    expect(press('ArrowDown').defaultPrevented).toBe(true)
    expect(press('Enter').defaultPrevented).toBe(true)
  })

  test('tab and esc close', async () => {
    await open({ keyboard: true })
    press('Tab')
    expect(menu()).toBeNull()
    await open({ keyboard: true })
    press('Escape')
    expect(menu()).toBeNull()
  })

  test('keys the menu does not own are left alone', async () => {
    await open({ keyboard: true })
    const ev = press('x')
    expect(ev.defaultPrevented).toBe(false)
    expect(menu()).not.toBeNull()
  })

  test('ctrl / alt / meta keys are never the menu: alt+1 is a tab jump, not item 1', async () => {
    await open({ keyboard: true })
    for (const mod of ['altKey', 'ctrlKey', 'metaKey']) {
      const ev = press('1', { [mod]: true })
      expect(ev.defaultPrevented).toBe(false)
    }
    press('ArrowDown', { altKey: true })
    press('Escape', { ctrlKey: true })
    expect(fired).toEqual([])
    expect(menu()).not.toBeNull()
    expect(doc.activeElement).toBe(rows()[0])
  })
})

describe('mouse still works', () => {
  test('hovering an item moves focus to it, so exactly one row is lit', async () => {
    await open({})
    rows()[1].dispatchEvent(new win.MouseEvent('mouseenter'))
    expect(doc.activeElement).toBe(rows()[1])
    rows()[2].dispatchEvent(new win.MouseEvent('mouseenter'))
    expect(doc.activeElement).toBe(rows()[2])
  })

  test('click uses an item', async () => {
    await open({})
    rows()[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    expect(fired).toEqual(['copy'])
    expect(menu()).toBeNull()
  })

  test('a click outside closes it', async () => {
    await open({})
    doc.getElementById('other').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }))
    expect(menu()).toBeNull()
  })

  test('the id stays #hs-mc-msg-ctx: the esc-owner check looks for it', () => {
    expect(SRC).toContain("id: 'hs-mc-msg-ctx'")
  })
})

describe('keys the menu takes never reach the page', () => {
  test('Space picks the item, and its keyup is eaten too (youtube toggles play on keyup)', async () => {
    await open({ keyboard: true })
    const page = []
    // stand-in for youtube's global hotkey listener: document, bubble phase
    const pageKeys = (e) => page.push(`${e.type}:${e.key}`)
    doc.addEventListener('keydown', pageKeys)
    doc.addEventListener('keyup', pageKeys)
    const down = new win.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    doc.activeElement.dispatchEvent(down)
    // the menu closed on keydown: the keyup lands wherever focus went back to
    const up = new win.KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
    doc.activeElement.dispatchEvent(up)
    expect(fired).toEqual(['reply'])
    expect([down.defaultPrevented, up.defaultPrevented]).toEqual([true, true])
    expect(page).toEqual([])
    // a key the menu did not take keeps its keyup
    doc.body.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'k', code: 'KeyK', bubbles: true }))
    expect(page).toEqual(['keyup:k'])
  })
})
