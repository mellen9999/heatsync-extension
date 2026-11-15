// startChatHidden: every tab opens with chat hidden and \ is the only way to show it there. The choice
// stays tab-local like the \ hide itself — a tab where chat was shown on purpose keeps it through a
// reload — and while hidden on youtube the page is left as it is without us: no reserve, no forced
// dark theme, youtube's own chat back.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (...p) => readFileSync(join(root, 'src', ...p), 'utf8').replace(/\r\n/g, '\n')
const panelActions = read('multichat', 'panel-actions.js')
const chatPosition = read('multichat', 'chat-position.js')
const mainStorage = read('multichat', 'main-storage.js')
const mainSettings = read('multichat', 'main-settings.js')
const early = read('content', 'early-layout.js')
const css = read('multichat', 'styles', '17-platform-position.css')
const schema = read('lib', 'settings-schema.js')

function carve(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no ${name}`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}

function makeSession(init = {}) {
  const m = new Map(Object.entries(init))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  }
}

// toggleChatHidden + _saveChatHiddenLocal + ensureChatRestorePill with the page stubbed out
function world({ startHidden = false, position = 'right' } = {}) {
  const sessionStorage = makeSession()
  const events = []
  const appended = []
  let pill = null
  const document = {
    body: {
      classList: { contains: () => false },
      appendChild: (el) => {
        pill = el
        appended.push(el)
      },
    },
    getElementById: (id) => (id === 'hs-chat-restore-pill' ? pill : null),
    createElement: () => ({
      dataset: {},
      addEventListener() {},
      remove() {
        pill = null
      },
    }),
    dispatchEvent: (e) => events.push(e.type),
  }
  const scope = { chatPosition: position, chatPositionPrevious: 'right', chatHiddenLocal: false }
  const fn = new Function(
    'document',
    'sessionStorage',
    'getSetting',
    'applyChatPosition',
    'saveUiSetting',
    'log',
    't',
    'Event',
    'scope',
    `let chatPosition = scope.chatPosition, chatPositionPrevious = scope.chatPositionPrevious, chatHiddenLocal = scope.chatHiddenLocal
     ${carve(panelActions, '_saveChatHiddenLocal')}
     ${carve(panelActions, 'toggleChatHidden')}
     ${carve(panelActions, 'ensureChatRestorePill')}
     return {
       toggle: () => toggleChatHidden(),
       pill: (show) => ensureChatRestorePill(show),
       state: () => ({ chatPosition, chatHiddenLocal }),
     }`,
  )
  const api = fn(
    document,
    sessionStorage,
    (k) => (k === 'startChatHidden' ? startHidden : undefined),
    () => {},
    () => {},
    () => {},
    (k) => k,
    class {
      constructor(type) {
        this.type = type
      }
    },
    scope,
  )
  return { ...api, sessionStorage, events, getPill: () => pill }
}

describe('startChatHidden', () => {
  test('a bool in the layout section, off by default', () => {
    const i = schema.indexOf("key: 'startChatHidden'")
    expect(i).toBeGreaterThan(-1)
    const entry = schema.slice(i, schema.indexOf('},', i))
    expect(entry).toContain("type: 'bool'")
    expect(entry).toContain('default: false')
    expect(entry).toContain("section: 'layout'")
    expect(entry).toContain("apply: 'startChatHidden'")
    expect(mainSettings).toContain("localStorage.setItem('hs_layout_startChatHidden'")
  })

  test('\\ shows chat in this tab and the tab remembers it was shown on purpose', () => {
    const w = world({ startHidden: true, position: 'hidden' })
    w.toggle()
    expect(w.state().chatPosition).toBe('right')
    expect(w.sessionStorage.getItem('hs-chat-shown-local')).toBe('1')
    expect(w.sessionStorage.getItem('hs-chat-hidden-local')).toBe(null)
    w.toggle()
    expect(w.state().chatPosition).toBe('hidden')
    expect(w.sessionStorage.getItem('hs-chat-hidden-local')).toBe('1')
    expect(w.sessionStorage.getItem('hs-chat-shown-local')).toBe(null)
  })

  test('every \\ tells youtube to re-lay out at once', () => {
    const w = world()
    w.toggle()
    w.toggle()
    expect(w.events).toEqual(['hs-chat-hidden-change', 'hs-chat-hidden-change'])
    expect(mainStorage).toContain("cleanup.addEventListener(document, 'hs-chat-hidden-change', checkYtLive)")
  })

  test('on: no edge pill, \\ is the only way back', () => {
    const w = world({ startHidden: true })
    w.pill(true)
    expect(w.getPill()).toBe(null)
  })

  test('off: the edge pill still shows on a \\ hide', () => {
    const w = world({ startHidden: false })
    w.pill(true)
    expect(w.getPill()).not.toBe(null)
  })

  test('a new tab starts hidden unless chat was shown in it, and a popout never does', () => {
    const load = carve(chatPosition, 'loadChatPosition')
    expect(load).toContain('stored.ui_settings?.startChatHidden === true')
    expect(load).toContain("!sessionStorage.getItem('hs-chat-shown-local')")
    expect(load).toContain("!document.body.classList.contains('hs-popout')")
    // the document_start prepaint follows, so a start-hidden tab never flashes the panel
    const i = early.indexOf("readLS('startChatHidden'")
    expect(i).toBeGreaterThan(early.indexOf('const isPopout ='))
    expect(i).toBeLessThan(early.indexOf('const doPrepaint'))
    expect(early.slice(i - 80, i)).toContain('!isPopout')
  })

  test('hidden on youtube: no reserve, no forced dark, youtube chat back', () => {
    const show = mainStorage.slice(
      mainStorage.indexOf('const showYtChat ='),
      mainStorage.indexOf('// YT sizes its grids'),
    )
    expect(show).toContain("chatPosition !== 'hidden'")
    for (const line of css
      .split('\n')
      .filter((l) => /ytd-live-chat-frame|#chat-container \{/.test(l) && l.includes(':has(#hs-mc-container)'))) {
      expect(line).toContain(':not(.hs-chat-hidden)')
    }
  })
})
