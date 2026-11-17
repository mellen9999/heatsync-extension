/**
 * A pane nobody can see draws nothing. The merged-tab render had a 500ms fallback timer that
 * fired in background tabs, so every hidden tab showing a merged channel (any kick channel
 * whose name also has twitch chat) rebuilt its whole pane twice a second: 700 rows drawn in
 * 40s behind another tab (s11, firefox, 11-16). Runs the real schedulers from
 * src/multichat/main-messages.js against a hidden and a shown document.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-messages.js'), 'utf8')
const fn = (name) => {
  const s = SRC.indexOf(`function ${name}(`)
  if (s < 0) throw new Error(`no ${name}`)
  return SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)
}
const BODY = ['_paneHidden', '_skipHiddenRender', 'scheduleMergedRender', 'scheduleRenderMessages'].map(fn).join('\n')

function pane({ hidden, focus = false, popout = false, wedged = false }) {
  const timers = []
  const rafs = []
  const state = { renders: 0, skipped: false }
  const env = {
    document: {
      hidden,
      hasFocus: () => focus,
      body: { classList: { contains: (c) => popout && c === 'hs-popout' } },
    },
    cleanup: {
      setTimeout: (f) => timers.push(f),
      clearTimeout: () => {},
    },
    rafOrTimeout: (f) => rafs.push(f) && 1,
    renderMessages: () => state.renders++,
    getChannelById: () => ({ id: 'kripp' }),
  }
  const run = new Function(
    ...Object.keys(env),
    'state',
    `let _hiddenSkippedAppend = false, _visWedged = ${wedged}, currentTab = 'live'
     let _multiPlatformRenderTimer = null, _multiPlatformRenderAt = 0
     let _renderCollapseTimer = null, _renderCollapseFirstAt = 0
     ${BODY}
     return { scheduleMergedRender, scheduleRenderMessages, skipped: () => _hiddenSkippedAppend }`,
  )(...Object.values(env), state)
  const flush = () => {
    for (const f of [...rafs.splice(0), ...timers.splice(0)]) f()
  }
  return { ...run, flush, state, doc: env.document, queued: () => timers.length + rafs.length }
}

test('a hidden tab: a stream of merged messages queues nothing and draws nothing', () => {
  const p = pane({ hidden: true })
  for (let i = 0; i < 50; i++) p.scheduleMergedRender()
  expect(p.queued()).toBe(0)
  p.flush()
  expect(p.state.renders).toBe(0)
  expect(p.skipped()).toBe(true) // the catch-up on return renders once
})

test('a render queued just before the tab hid does not draw when it fires', () => {
  const p = pane({ hidden: false })
  p.scheduleMergedRender()
  p.scheduleRenderMessages()
  p.doc.hidden = true
  p.flush()
  expect(p.state.renders).toBe(0)
  expect(p.skipped()).toBe(true)
})

test('a shown tab draws merged messages', () => {
  const p = pane({ hidden: false })
  p.scheduleMergedRender()
  p.flush()
  expect(p.state.renders).toBe(1)
  expect(p.skipped()).toBe(false)
})

test('hidden but focused, wedged or a popout: the reader is looking, so it draws', () => {
  for (const o of [{ focus: true }, { wedged: true }, { popout: true }]) {
    const p = pane({ hidden: true, ...o })
    p.scheduleMergedRender()
    p.scheduleRenderMessages()
    p.flush()
    expect(p.state.renders).toBe(2)
  }
})

test('the collapsed render waits out a hidden tab too', () => {
  const p = pane({ hidden: true })
  p.scheduleRenderMessages()
  p.flush()
  expect(p.state.renders).toBe(0)
  expect(p.skipped()).toBe(true)
})
