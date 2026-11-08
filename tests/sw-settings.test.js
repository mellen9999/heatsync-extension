// settings through the service worker, executed: what a content script, the server and a worker
// restart each do to a setting on its way into (and out of) chrome.storage. real worker, fake
// chrome (tests/harness/sw.js) whose storage is async + JSON-cloned like the real one.

import { describe, expect, test } from 'bun:test'
import { bootSw, tabSender } from './harness/sw.js'

const AUTH = { name: 'auth', value: 'tok-1', domain: 'heatsync.org' }
const TAB_URL = 'https://www.twitch.tv/kripp'
const tab = tabSender(7, TAB_URL)

const boot = (opts = {}) => bootSw({ cookies: [AUTH], tabs: [{ id: 7, url: TAB_URL }], sockets: 'open', ...opts })
const ui = (sw) => sw.storage.sync.snapshot().ui_settings
const patch = (sw, p, extra = {}) => sw.send({ type: 'ui_settings_rmw', patch: p, ...extra }, tab)
const frames = (sw, type) => sw.socket().frames.filter((f) => f.type === type)

describe('ui_settings_rmw (a page changing a setting)', () => {
  test('is stored in sync storage, merged into what was already there', async () => {
    const sw = await boot({ storage: { sync: { ui_settings: { zebra: true, fontSize: 14 } } } })
    expect(await patch(sw, { timestamps: false, fontSize: 16 })).toEqual({ ok: true })
    expect(ui(sw)).toEqual({ zebra: true, fontSize: 16, timestamps: false })
  })

  test('survives the worker being evicted: the next write builds on it', async () => {
    const sw = await boot()
    await patch(sw, { zebra: true })
    const woken = await sw.restart()
    expect(ui(woken)).toEqual({ zebra: true })
    await patch(woken, { timestamps: false })
    expect(ui(woken)).toEqual({ zebra: true, timestamps: false })
  })

  test('five writes at once all land (serialised: none overwrites another)', async () => {
    const sw = await boot()
    const calls = ['a', 'b', 'c', 'd', 'e'].map((k) => sw.post({ type: 'ui_settings_rmw', patch: { [k]: k } }, tab))
    await sw.settle()
    expect(calls.map((c) => c.response)).toEqual(Array(5).fill({ ok: true }))
    expect(ui(sw)).toEqual({ a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' })
  })

  test('only a plain object is accepted', async () => {
    const sw = await boot()
    for (const bad of [null, [], 'zebra', 7]) {
      expect(await patch(sw, bad), JSON.stringify(bad)).toEqual({ ok: false, error: 'patch must be a plain object' })
    }
    expect(ui(sw)).toBeUndefined()
  })

  test('hostile or oversized entries are dropped before they reach storage', async () => {
    const sw = await boot()
    const hostile = JSON.parse(
      `{"__proto__":{"polluted":true},"constructor":1,"7":"numeric","ok":"yes","huge":"${'x'.repeat(5000)}","${'k'.repeat(65)}":1}`,
    )
    expect(await patch(sw, hostile)).toEqual({ ok: true })
    expect(ui(sw)).toEqual({ ok: 'yes' })
    expect(sw.eval('({}).polluted')).toBeUndefined()
  })

  test('dropRetired clears retired keys from the stored blob and keeps the rest', async () => {
    const sw = await boot({
      storage: { sync: { ui_settings: { zebra: true, emoteWysiwyg: true, hideChatHeader: false } } },
    })
    await patch(sw, { fontSize: 15 }, { dropRetired: true })
    expect(ui(sw)).toEqual({ zebra: true, fontSize: 15 })
  })

  test('a throttled write is retried once after a second', async () => {
    const sw = await boot()
    sw.storage.sync.fail('set', new Error('MAX_WRITE_OPERATIONS_PER_MINUTE exceeded'))
    const call = sw.post({ type: 'ui_settings_rmw', patch: { zebra: true } }, tab)
    await sw.settle()
    expect(call.responded).toBe(false) // waiting out the retry
    await sw.advance(1000)
    expect(call.response).toEqual({ ok: true })
    expect(ui(sw)).toEqual({ zebra: true })
  })

  test('a write that fails twice (quota) is reported, and the next write still works', async () => {
    const sw = await boot()
    sw.storage.sync.fail('set', new Error('QUOTA_BYTES_PER_ITEM quota exceeded'))
    sw.storage.sync.fail('set', new Error('QUOTA_BYTES_PER_ITEM quota exceeded'))
    const call = sw.post({ type: 'ui_settings_rmw', patch: { zebra: true } }, tab)
    await sw.advance(1000)
    expect(call.response).toEqual({ ok: false, error: 'QUOTA_BYTES_PER_ITEM quota exceeded' })
    expect(ui(sw)).toBeUndefined()
    // the failure did not poison the chain behind it
    expect(await patch(sw, { zebra: true })).toEqual({ ok: true })
    expect(ui(sw)).toEqual({ zebra: true })
  })
})

describe('site_overlay_set (the per-site on/off switch)', () => {
  test('is stored under subsystems and sent to the server, so the next boot merge cannot undo it', async () => {
    const sw = await boot({
      storage: { sync: { ui_settings: { zebra: true, subsystems: { 'overlay-kick': false } } } },
    })
    sw.socket().receive({ type: 'authenticated', userId: 1 })
    await sw.advance(3000)
    const before = frames(sw, 'ui-state:sync').length

    expect(await sw.send({ type: 'site_overlay_set', gate: 'overlay-twitch', on: false }, tab)).toEqual({ ok: true })

    expect(ui(sw)).toEqual({ zebra: true, subsystems: { 'overlay-kick': false, 'overlay-twitch': false } })
    expect(frames(sw, 'ui-state:sync').slice(before)).toEqual([
      { type: 'ui-state:sync', patch: { subsystems: { 'overlay-kick': false, 'overlay-twitch': false } } },
    ])
  })

  test('a gate that is not a site overlay is refused: nothing stored, nothing sent', async () => {
    const sw = await boot()
    sw.socket().receive({ type: 'authenticated', userId: 1 })
    await sw.advance(3000)
    const before = frames(sw, 'ui-state:sync').length
    for (const gate of ['feed', '__proto__', 'overlay-myspace']) {
      expect(await sw.send({ type: 'site_overlay_set', gate, on: false }, tab), gate).toEqual({
        ok: false,
        error: 'unknown gate',
      })
    }
    expect(ui(sw)).toBeUndefined()
    expect(frames(sw, 'ui-state:sync')).toHaveLength(before)
  })
})

describe('settings pushed from the server (another device changed one)', () => {
  const server = async (sw, frame) => {
    sw.socket().receive(frame)
    await sw.settle()
  }

  test('settings:patch is merged into ui_settings', async () => {
    const sw = await boot({ storage: { sync: { ui_settings: { zebra: true } } } })
    await server(sw, { type: 'settings:patch', patches: { fontSize: 18 } })
    expect(ui(sw)).toEqual({ zebra: true, fontSize: 18 })
  })

  test('settings:delete removes one key, and only a key (never a path into another storage key)', async () => {
    const sw = await boot({ storage: { sync: { ui_settings: { zebra: true, fontSize: 18 } } } })
    await server(sw, { type: 'settings:delete', key: 'zebra' })
    expect(ui(sw)).toEqual({ fontSize: 18 })
    await server(sw, { type: 'settings:delete', key: 'x'.repeat(65) })
    await server(sw, { type: 'settings:delete', key: { $ne: 1 } })
    expect(ui(sw)).toEqual({ fontSize: 18 })
  })

  test('ui-state:update is sanitised on the way in', async () => {
    const sw = await boot({ storage: { sync: { ui_settings: { zebra: true } } } })
    await server(sw, { type: 'ui-state:update', state: JSON.parse('{"timestamps":false,"__proto__":{"polluted":1}}') })
    expect(ui(sw)).toEqual({ zebra: true, timestamps: false })
    expect(sw.eval('({}).polluted')).toBeUndefined()
  })

  test('a malformed frame changes nothing', async () => {
    const sw = await boot({ storage: { sync: { ui_settings: { zebra: true } } } })
    await server(sw, { type: 'settings:patch', patches: 'nope' })
    await server(sw, { type: 'ui-state:update', state: null })
    expect(ui(sw)).toEqual({ zebra: true })
  })
})

describe('content filters (a server setting that changes what the worker asks for)', () => {
  const gets = (sw) => sw.net.callsTo('/api/emotes?').map((c) => c.url)

  test('a push flips the flag, persists it, and the next emote fetch asks for it', async () => {
    const sw = await boot()
    expect(gets(sw)[0]).toContain('include_sexual=false')

    sw.socket().receive({ type: 'user_settings:update', show_sexual_emotes: true })
    await sw.settle()
    expect(sw.storage.local.snapshot().viewer_show_sexual).toBe(true)

    await sw.send({ type: 'refresh_all' }, tab)
    await sw.settle()
    expect(gets(sw).at(-1)).toContain('include_sexual=true')
    expect(gets(sw).at(-1)).toContain('include_gore=false') // only the one that changed
  })

  test('and it is still on after the worker is evicted and wakes up', async () => {
    const sw = await boot()
    sw.socket().receive({ type: 'user_settings:update', show_sexual_emotes: true })
    await sw.settle()
    const woken = await sw.restart()
    expect(woken.net.callsTo('/api/emotes?')[0].url).toContain('include_sexual=true')
  })

  test('a signed-out worker resets the filters to the safe default, whatever storage held', async () => {
    const sw = await boot({ cookies: [], storage: { local: { viewer_show_sexual: true, viewer_show_gore: true } } })
    await sw.settle()
    const stored = sw.storage.local.snapshot()
    expect(stored.viewer_show_sexual).toBe(false)
    expect(stored.viewer_show_gore).toBe(false)
    await sw.send({ type: 'refresh_all' }, tab)
    expect(sw.net.callsTo('/api/emotes?').at(-1).url).toContain('include_sexual=false')
  })
})
