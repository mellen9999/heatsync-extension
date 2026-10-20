/**
 * Channel-tab read marks sync like the notification surfaces: a right-click
 * clear reaches the server (so every other device clears), the boot GET and the
 * tabseen:update frame flow into main.js's map, and a write the server never
 * acked is replayed rather than lost. Runs the real block out of seen-state.js
 * against stubs.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'seen-state.js'), 'utf8')
const BLOCK = SRC.slice(SRC.indexOf('// ── channel tabs'), SRC.indexOf('// Apply a WS-pushed seen:update'))

function rig({ token = 'tok', reply = { ok: true } } = {}) {
  const posts = []
  const handlers = {}
  const fn = new Function(
    'env',
    `const { apiFetch, warn, _onceGuardsSeenState, cleanup, document } = env
     let hsAuthToken = env.token
     ${BLOCK}
     return { setTabSeenSink, applyRemoteTabSeen, pushTabSeen, pending: _pendingTabSeen }`,
  )({
    token,
    apiFetch: async (path, opts) => {
      posts.push({ path, body: opts.body })
      if (reply === 'throw') throw new Error('offline')
      return reply
    },
    warn: () => {},
    _onceGuardsSeenState: {},
    cleanup: { addEventListener: (_d, ev, h) => (handlers[ev] = h) },
    document: { visibilityState: 'visible' },
  })
  return { ...fn, posts, handlers }
}

describe('push', () => {
  test('a read posts the tab and time', async () => {
    const r = rig()
    await r.pushTabSeen('nl_kripp', 1700000000000)
    expect(r.posts).toEqual([{ path: '/api/user/tab-seen', body: { tab: 'nl_kripp', at: 1700000000000 } }])
    expect(r.pending.size).toBe(0)
  })

  test('anonymous never posts', async () => {
    const r = rig({ token: false })
    await r.pushTabSeen('nl_kripp', 5)
    expect(r.posts).toEqual([])
  })

  test('a refused write is kept for replay, newest wins', async () => {
    const r = rig({ reply: { ok: false } })
    await r.pushTabSeen('a', 5)
    await r.pushTabSeen('a', 9)
    await r.pushTabSeen('a', 7)
    expect(r.pending.get('a')).toBe(9)
  })

  test('a thrown write is kept for replay', async () => {
    const r = rig({ reply: 'throw' })
    await r.pushTabSeen('a', 5)
    expect(r.pending.get('a')).toBe(5)
  })
})

describe('receive', () => {
  test('remote marks reach the sink; boot marks ask to reconcile', () => {
    const r = rig()
    const got = []
    r.setTabSeenSink((m, rec) => got.push([m, rec]))
    r.applyRemoteTabSeen({ a: 1 })
    r.applyRemoteTabSeen({ a: 1, b: 2 }, true)
    expect(got).toEqual([
      [{ a: 1 }, false],
      [{ a: 1, b: 2 }, true],
    ])
  })

  test('a boot GET that lands before main.js registers is replayed, not dropped', () => {
    const r = rig()
    r.applyRemoteTabSeen({ a: 1 }, true)
    r.applyRemoteTabSeen({ b: 2 })
    const got = []
    r.setTabSeenSink((m, rec) => got.push([m, rec]))
    expect(got).toEqual([[{ a: 1, b: 2 }, true]])
  })

  test('garbage is ignored', () => {
    const r = rig()
    const got = []
    r.setTabSeenSink((m) => got.push(m))
    r.applyRemoteTabSeen(null)
    r.applyRemoteTabSeen('x')
    expect(got).toEqual([])
  })
})
