/**
 * Tab mode — the rover cursor over the multichat tab strip.
 *
 * tab-mode.js is a plain source file concatenated into the content bundle, so
 * it's loaded through `new Function` with its call-time dependencies injected,
 * the same way message-ordering.test.js loads social.js.
 *
 * The fences that matter here are the host-page ones: this runs inside
 * twitch.tv, so `t` must be inert until vi mode is on, must never fire while an
 * editable is focused, and must not swallow the key when there's no strip to
 * put a cursor on.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = (...p) => join(import.meta.dir, '..', ...p)
const SRC = readFileSync(dir('src', 'multichat', 'tab-mode.js'), 'utf8')
const INPUT = readFileSync(dir('src', 'multichat', 'input.js'), 'utf8')
const CHANNEL_MGMT = readFileSync(dir('src', 'multichat', 'channel-mgmt.js'), 'utf8')
const NOTIFS = readFileSync(dir('src', 'multichat', 'notifs.js'), 'utf8')
const TABBAR_CSS = readFileSync(dir('src', 'multichat', 'styles', '02-tab-bar.css'), 'utf8')
const PALETTE_CSS = readFileSync(dir('src', 'multichat', 'styles', '00-palette.css'), 'utf8')

/**
 * Minimal fake tab strip. jsdom/happy-dom isn't a repo dependency (see
 * paints.test.js for the same call), and tab-mode.js only touches a handful of
 * DOM members — classList, dataset, style.display, textContent, offsetParent,
 * querySelector/querySelectorAll and scrollIntoView — so hand-rolling is
 * cheaper and more honest than pulling in a DOM.
 */
function fakeTab(id, parent) {
  const classes = new Set(['hs-mc-tab'])
  return {
    dataset: { tab: id },
    style: {},
    textContent: id,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    scrollIntoView() {},
    remove() {
      const i = parent.indexOf(this)
      if (i !== -1) parent.splice(i, 1)
    },
  }
}

/** @param spec 'id' for a channel tab, 'id!' for a fixed surface */
function makeBar(spec, { visible = true } = {}) {
  const kids = []
  for (const sp of spec) kids.push(fakeTab(sp.endsWith('!') ? sp.slice(0, -1) : sp, kids))
  kids.push(fakeTab('add', kids))
  const scroll = {
    querySelectorAll: () => kids.filter((k) => k.style.display !== 'none'),
    _kids: kids,
  }
  return {
    offsetParent: visible ? {} : null,
    querySelector: (sel) => (sel === '.hs-mc-tabs-scroll' ? scroll : null),
    _kids: kids,
    _byId: (id) => kids.find((k) => k.dataset.tab === id),
  }
}

function load(bar, { currentTab = 'live', channels = [] } = {}) {
  const calls = { switched: [], removed: [], moved: [], status: [], dismissed: [] }
  const build = new Function(
    'tabBarElement',
    'currentTab',
    'getChannelById',
    'switchTab',
    'removeChannel',
    'moveChannelOrder',
    'HsNotifs',
    'getComputedStyle',
    `${SRC}
    return { enterTabMode, exitTabMode, handleTabModeKey, tabModeActive, tabModeTabs, isChannelTab }`,
  )
  const api = build(
    bar,
    currentTab,
    (id) => (channels.includes(id) ? { id } : null),
    (id) => calls.switched.push(id),
    (id) => {
      calls.removed.push(id)
      bar._byId(id)?.remove()
    },
    (id, d) => {
      calls.moved.push([id, d])
      return true
    },
    { emit: (_t, d) => calls.status.push(d.text), dismissByKey: (k) => calls.dismissed.push(k) },
    () => ({ position: 'static' }),
  )
  const cursorId = () => bar._kids.find((k) => k._classes.has('hs-mc-tab-cursor'))?.dataset.tab
  return { ...api, calls, bar, cursorId }
}

const press = (api, key) => api.handleTabModeKey({ key, preventDefault() {} })

describe('the rover list', () => {
  test('walks surfaces and channels but never the + button', () => {
    const bar = makeBar(['live!', 'mentions!', 'alpha'])
    const api = load(bar, { channels: ['alpha'] })
    expect(api.tabModeTabs().map((t) => t.dataset.tab)).toEqual(['live', 'mentions', 'alpha'])
  })

  test('skips tabs applyHiddenTabs has display:none-d', () => {
    const bar = makeBar(['live!', 'pinned!', 'alpha'])
    bar._byId('pinned').style.display = 'none'
    const api = load(bar, { channels: ['alpha'] })
    expect(api.tabModeTabs().map((t) => t.dataset.tab)).toEqual(['live', 'alpha'])
  })

  test('is empty while the chat is hidden, so t falls through to the host page', () => {
    const bar = makeBar(['live!', 'alpha'], { visible: false })
    const api = load(bar, { channels: ['alpha'] })
    expect(api.tabModeTabs()).toEqual([])
    expect(api.enterTabMode()).toBe(false)
    expect(api.tabModeActive()).toBe(false)
  })
})

describe('motion', () => {
  let api
  beforeEach(() => {
    const bar = makeBar(['live!', 'mentions!', 'alpha', 'beta'])
    api = load(bar, { currentTab: 'alpha', channels: ['alpha', 'beta'] })
    api.enterTabMode()
  })

  test('starts on the tab you have open', () => {
    expect(api.cursorId()).toBe('alpha')
  })

  test('j/k move and clamp at both ends', () => {
    press(api, 'j')
    expect(api.cursorId()).toBe('beta')
    press(api, 'j')
    expect(api.cursorId()).toBe('beta')
    press(api, 'k')
    press(api, 'k')
    press(api, 'k')
    press(api, 'k')
    expect(api.cursorId()).toBe('live')
  })

  test('counts and g/G work', () => {
    press(api, 'g')
    expect(api.cursorId()).toBe('live')
    press(api, '3')
    press(api, 'j')
    expect(api.cursorId()).toBe('beta')
    press(api, 'G')
    expect(api.cursorId()).toBe('beta')
  })

  test('moving never switches a tab — that is what enter is for', () => {
    press(api, 'j')
    press(api, 'k')
    press(api, 'g')
    expect(api.calls.switched).toEqual([])
    press(api, 'Enter')
    expect(api.calls.switched).toEqual(['live'])
    expect(api.tabModeActive()).toBe(false)
  })

  test('leaving clears the cursor and the status line', () => {
    press(api, 'Escape')
    expect(api.cursorId()).toBeUndefined()
    expect(api.calls.dismissed).toContain('tab-mode')
  })

  test.each(['Escape', 'q', 't'])('%s exits without switching', (k) => {
    press(api, k)
    expect(api.tabModeActive()).toBe(false)
    expect(api.calls.switched).toEqual([])
  })

  test('unbound keys are swallowed, not leaked to the page underneath', () => {
    expect(press(api, 'z')).toBe(true)
    expect(api.tabModeActive()).toBe(true)
  })
})

describe('reorder and close are channels-only', () => {
  test('J/K move a channel and carry the cursor with it', () => {
    const bar = makeBar(['live!', 'alpha', 'beta'])
    const api = load(bar, { currentTab: 'alpha', channels: ['alpha', 'beta'] })
    api.enterTabMode()
    press(api, 'J')
    expect(api.calls.moved).toEqual([['alpha', 1]])
    expect(api.cursorId()).toBe('beta') // index followed the tab
  })

  test('J/K refuse a fixed surface, out loud', () => {
    const bar = makeBar(['live!', 'alpha'])
    const api = load(bar, { currentTab: 'live', channels: ['alpha'] })
    api.enterTabMode()
    press(api, 'J')
    expect(api.calls.moved).toEqual([])
    expect(api.calls.status.at(-1)).toBe('that tab is fixed')
  })

  test('d closes a channel and lands the cursor on its neighbour', () => {
    const bar = makeBar(['live!', 'alpha', 'beta'])
    const api = load(bar, { currentTab: 'alpha', channels: ['alpha', 'beta'] })
    api.enterTabMode()
    press(api, 'd')
    expect(api.calls.removed).toEqual(['alpha'])
    expect(api.cursorId()).toBe('beta')
    expect(api.tabModeActive()).toBe(true)
  })

  test('d refuses a fixed surface, out loud', () => {
    const bar = makeBar(['mentions!', 'alpha'])
    const api = load(bar, { currentTab: 'mentions', channels: ['alpha'] })
    api.enterTabMode()
    press(api, 'd')
    expect(api.calls.removed).toEqual([])
    expect(api.calls.status.at(-1)).toBe("that tab can't be closed")
  })

  test('a leaves the mode first, so the add form owns the keyboard', () => {
    const bar = makeBar(['live!'])
    const api = load(bar, { currentTab: 'live' })
    api.enterTabMode()
    press(api, 'a')
    expect(api.tabModeActive()).toBe(false)
    expect(api.calls.switched).toEqual(['add'])
  })
})

describe('host-page fences', () => {
  test('t is gated on vi mode and skips editables, in the capture phase', () => {
    const i = INPUT.indexOf('_onceGuardsInput.tabModeHandler')
    expect(i).toBeGreaterThan(-1)
    const block = INPUT.slice(i, i + 1800)
    expect(block).toContain("if (e.key !== 't' || !viModeEnabled) return")
    expect(block).toContain('active.isContentEditable')
    expect(block).toContain('e.ctrlKey || e.altKey || e.metaKey')
    expect(block).toContain('capture: true')
    // A failed enter must NOT preventDefault — the host page keeps its key.
    expect(block).toContain('if (!enterTabMode()) return')
  })

  test('it is registered before the type-reveal handler that focuses the composer', () => {
    // Same target + same phase means registration order decides, and
    // type-reveal would otherwise eat a bare `t` into the input.
    expect(INPUT.indexOf('_onceGuardsInput.tabModeHandler')).toBeLessThan(
      INPUT.indexOf('_onceGuardsInput.typeRevealHandler'),
    )
  })

  test('the mode tears down with the rest of multichat', () => {
    const i = INPUT.indexOf('_onceGuardsInput.tabModeHandler')
    expect(INPUT.slice(i, i + 1800)).toContain('signal: mcSignal')
  })
})

describe('appearance', () => {
  test('the cursor is the keyboard invert token, never the brand orange', () => {
    expect(PALETTE_CSS).toContain('--hs-sel: #00ffff')
    expect(TABBAR_CSS).toContain('background: var(--hs-sel) !important')
    expect(TABBAR_CSS).not.toContain('ff8700')
  })

  test('the status line is persistent and dismissed by key, not on a timer', () => {
    const i = NOTIFS.indexOf("registerType('tab-mode'")
    expect(i).toBeGreaterThan(-1)
    const block = NOTIFS.slice(i, NOTIFS.indexOf('  })', i))
    expect(block).toContain("layer: 'statusbar'")
    expect(block).not.toContain('timeout')
    expect(SRC).toContain("HsNotifs.dismissByKey('tab-mode', 'tab-mode')")
  })
})

describe('reorder plumbing', () => {
  test('moveChannelOrder persists and repaints, and refuses at the ends', () => {
    const i = CHANNEL_MGMT.indexOf('function moveChannelOrder(')
    expect(i).toBeGreaterThan(-1)
    const body = CHANNEL_MGMT.slice(i, CHANNEL_MGMT.indexOf('\nfunction removeChannel', i))
    expect(body).toContain('saveConfig()')
    expect(body).toContain('updateTabBar()')
    expect(body).toContain('if (from < 0 || to < 0 || to >= list.length) return false')
  })
})
