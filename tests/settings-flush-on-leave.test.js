import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

/**
 * A changed setting waits 100ms before it is written, and a big text setting (filter rules) waits
 * 1.2s more before it is sent to the other devices. Both waits were timers the page teardown
 * clears: change a setting and reload or close inside the window and it was never saved, or
 * never left this device and the older copy elsewhere came back over it. On pagehide everything
 * pending now goes out at once. saveUiSetting and flushUiSettings run for real.
 */
const MAIN = mainSource()
const s = MAIN.indexOf('function saveUiSetting(key, value) {')
const e = MAIN.indexOf('let _largeWsPatchTimer = null', s)
if (s < 0 || e < 0) throw new Error('carve: saveUiSetting moved')
const CODE = `${MAIN.slice(s, e)}let _largeWsPatchTimer = null`

function rig() {
  const timers = new Map()
  let nextId = 1
  const sent = []
  const local = []
  let awaited = 0
  const api = new Function(
    'cleanup',
    'browser',
    'safeSendMessage',
    'writeUiSettings',
    'env',
    `let _pendingSettings = null, _settingsSaveTimer = null
     const { UI_SYNC_BLOCKLIST, OVERFLOW_MIRROR_KEYS, DEVICE_LOCAL_KEYS, _LAYOUT_MIRROR_KEYS } = env
     const isLargeKeySyncEligible = (k) => k === 'chatFilterRules'
     const estimateSettingSize = () => 0, LARGE_KEY_SYNC_MAX = 32768
     const invalidateUiOverflowCache = () => {}, invalidateUiSettingsCache = () => {}
     const _mirrorLayoutToLS = () => {}, warn = () => {}, showToast = () => {}, t = (k) => k
     ${CODE}
     return { saveUiSetting, flushUiSettings }`,
  )(
    {
      setTimeout: (fn, ms) => {
        timers.set(nextId, { fn, ms })
        return nextId++
      },
      clearTimeout: (id) => timers.delete(id),
    },
    {
      storage: {
        local: {
          set: (patch) => {
            local.push(patch)
            return Promise.resolve()
          },
        },
        sync: {
          getBytesInUse: () => {
            awaited++
            return Promise.resolve(10)
          },
        },
      },
    },
    (m) => {
      sent.push(m)
      return Promise.resolve({ ok: true })
    },
    (patch) => {
      sent.push({ type: 'ui_settings_rmw', patch })
      return Promise.resolve(true)
    },
    {
      UI_SYNC_BLOCKLIST: new Set(['chatFilterRules']),
      OVERFLOW_MIRROR_KEYS: { chatFilterRules: 'chat_filter_rules' },
      DEVICE_LOCAL_KEYS: new Set(),
      _LAYOUT_MIRROR_KEYS: new Set(),
    },
  )
  const fire = (ms) => {
    for (const [id, tm] of [...timers]) {
      if (tm.ms !== ms) continue
      timers.delete(id)
      tm.fn()
    }
  }
  return { ...api, timers, sent, local, fire, awaited: () => awaited }
}
const ws = (r) => r.sent.filter((m) => m.type === 'ws_send').map((m) => m.data.patch)
const rmw = (r) => r.sent.filter((m) => m.type === 'ui_settings_rmw').map((m) => m.patch)

test('the page goes inside the 100ms wait: the setting is written and sent in that same turn', () => {
  const r = rig()
  r.saveUiSetting('compactMode', true)
  r.saveUiSetting('fontSize', 15)
  expect(r.sent).toEqual([])
  r.flushUiSettings(true)
  // synchronously: nothing here may wait on a promise, the page is gone before it resolves
  expect(rmw(r)).toEqual([{ compactMode: true, fontSize: 15 }])
  expect(ws(r)).toEqual([{ compactMode: true, fontSize: 15 }])
  expect(r.awaited()).toBe(0)
  expect(r.timers.size).toBe(0)
})

test('the page goes inside the 1.2s wait of a big text setting: it still reaches the other devices', () => {
  const r = rig()
  r.saveUiSetting('chatFilterRules', '[{"a":1}]')
  r.fire(100)
  expect(r.local).toEqual([{ chat_filter_rules: '[{"a":1}]' }])
  expect(ws(r)).toEqual([]) // still waiting out the slow debounce
  r.flushUiSettings(true)
  expect(ws(r)).toEqual([{ chatFilterRules: '[{"a":1}]' }])
  expect(r.timers.size).toBe(0)
})

test('changed and gone at once: the big setting is stored here and sent on, both', () => {
  const r = rig()
  r.saveUiSetting('chatFilterRules', '[]')
  r.flushUiSettings(true)
  expect(r.local).toEqual([{ chat_filter_rules: '[]' }])
  expect(ws(r)).toEqual([{ chatFilterRules: '[]' }])
})

test('nothing pending: leaving sends nothing, and a later flush sends nothing twice', () => {
  const r = rig()
  r.flushUiSettings(true)
  expect(r.sent).toEqual([])
  r.saveUiSetting('compactMode', false)
  r.flushUiSettings(true)
  r.flushUiSettings(true)
  r.fire(100)
  expect(rmw(r)).toEqual([{ compactMode: false }])
})

test('a page that stays keeps the waits: one write after 100ms, the big one sent after 1.2s', async () => {
  const r = rig()
  r.saveUiSetting('compactMode', true)
  r.saveUiSetting('compactMode', false)
  r.saveUiSetting('chatFilterRules', '[1]')
  expect(r.timers.size).toBe(1)
  r.fire(100)
  await new Promise((res) => setTimeout(res, 0))
  expect(rmw(r)).toEqual([{ compactMode: false }])
  expect(r.awaited()).toBe(1) // the quota check still runs on the normal path
  expect(ws(r)).toEqual([{ compactMode: false }])
  r.fire(1200)
  expect(ws(r)).toEqual([{ compactMode: false }, { chatFilterRules: '[1]' }])
})

test('the page teardown flushes before it clears the timers', () => {
  const boot = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'bootstrap.js'), 'utf8')
  const at = boot.indexOf("window.addEventListener('pagehide'")
  const body = boot.slice(at, boot.indexOf('\n})\n', at))
  expect(body.indexOf('flushUiSettings(true)')).toBeGreaterThan(-1)
  expect(body.indexOf('flushUiSettings(true)')).toBeLessThan(body.indexOf('lifecycle.abort()'))
})
