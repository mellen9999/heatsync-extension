/**
 * The frozen-but-flashing watchdog (dom_thrash) rebuilt the pane by clearing it and leaving the
 * redraw to the scheduler: the reader saw an empty pane first. And a setting that redraws every
 * row on purpose (bumpRenderEpoch) looked like thrash on a quiet chat, so flipping display
 * settings blanked the youtube pane (e2e s13, 11-16). Runs the real domThrashCheck from
 * src/multichat/main-messages.js over a happy-dom pane, its neighbours stubbed.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-messages.js'), 'utf8')
const fn = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`no ${name}`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}
// the watchdog's own state, as declared
const STATE = SRC.slice(SRC.indexOf('let _thrashObs = null'), SRC.indexOf('let _unpinnedStreak = 0'))

const any = new Proxy(() => {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : any), apply: () => undefined })

function pane({ tab = 'live' } = {}) {
  const win = new Window({ url: 'https://example.test/' })
  const doc = win.document
  doc.body.innerHTML = '<div id="hs-mc-messages"></div>'
  const msgs = doc.getElementById('hs-mc-messages')
  // the same rows drawn again: the newest row never changes
  const draw = () => {
    msgs.textContent = ''
    for (let i = 0; i < 6; i++) {
      const d = doc.createElement('div')
      d.className = 'hs-mc-msg'
      d.dataset.msgKey = `k${i}`
      msgs.appendChild(d)
    }
  }
  draw()
  const st = { heals: 0, renders: 0, emptyAfterHeal: false, diag: [] }
  const own = {
    document: doc,
    window: { __hsDiag: (e) => st.diag.push(e) },
    MutationObserver: win.MutationObserver,
    Date,
    currentTab: tab,
    _renderEpoch: 0,
    isScrolledUp: false,
    editingChannel: false,
    activeProfileCard: null,
    unpinnedCheck: () => {},
    zebraFlickerTally: () => ({ flips: 0, mid: 0 }),
    _tabNewestBuffered: () => null,
    _noHeal: () => false,
    hsPanePanelOpen: () => false,
    getChannelById: () => null,
    _dropAllTabCaches: () => {},
    _clearMessageIndices: () => {
      st.heals++
    },
    renderMessages: () => {
      st.renders++
      draw()
    },
  }
  const scope = new Proxy(own, {
    has: () => true,
    get: (o, k) => (k === Symbol.unscopables ? undefined : k in o ? o[k] : k in globalThis ? globalThis[k] : any),
    set: (o, k, v) => {
      o[k] = v
      return true
    },
  })
  const check = new Function('scope', `with (scope) { ${STATE}; ${fn('domThrashCheck')}; return domThrashCheck }`)(
    scope,
  )
  // one 2s window: the rows churn, the observer reports, the watchdog looks
  const tick = async ({ bump = false } = {}) => {
    if (bump) own._renderEpoch++
    draw()
    await new Promise((r) => setTimeout(r, 0))
    check()
    st.emptyAfterHeal ||= st.heals > 0 && !msgs.children.length
  }
  return { check, tick, st, msgs }
}

test('churn with the newest row unchanged heals, and the pane is never left empty', async () => {
  const p = pane()
  p.check() // arms the observers
  for (let i = 0; i < 5; i++) await p.tick()
  expect(p.st.diag).toContain('dom_thrash')
  expect(p.st.heals).toBe(1)
  expect(p.st.renders).toBe(1) // redrawn in the same task as the clear
  expect(p.st.emptyAfterHeal).toBe(false)
  expect(p.msgs.children.length).toBe(6)
})

test('a setting that redraws every row is not thrash', async () => {
  const p = pane()
  p.check()
  for (let i = 0; i < 8; i++) await p.tick({ bump: true })
  expect(p.st.diag).not.toContain('dom_thrash')
  expect(p.st.heals).toBe(0)
})

test('a settings pane is never torn down by the heal', async () => {
  const p = pane({ tab: 'settings' })
  p.check()
  for (let i = 0; i < 5; i++) await p.tick()
  expect(p.st.heals).toBe(0)
  expect(p.st.renders).toBe(0)
})
