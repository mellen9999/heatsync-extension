import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Inline [OP]/[RE] rows survive an ext reload: saveInlineNotif writes them to
 * storage, restoreInlineNotifs puts them back into every channel buffer at
 * their real time, once. The shipped source runs against stubbed globals.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const start = SRC.indexOf('const INLINE_NOTIF_KEY')
const end = SRC.indexOf('// Dedup: track recent server-sourced YouTube messages')
const BLOCK = SRC.slice(start, end)

class Ring {
  constructor() {
    this.items = []
  }
  getAll() {
    return [...this.items]
  }
  insertOrdered(m) {
    const i = this.items.findIndex((x) => x.time > m.time)
    if (i === -1) this.items.push(m)
    else this.items.splice(i, 0, m)
  }
}

function load({ toggles = { op: true, re: true, mop: true } } = {}) {
  const store = {}
  const twitch = new Ring()
  const g = {
    api: {
      storage: {
        local: {
          get: async (k) => ({ [k]: store[k] }),
          set: async (o) => Object.assign(store, o),
        },
      },
    },
    saveQueue: Promise.resolve(),
    INLINE_NOTIF_TYPES: {
      op: { color: '#f00', borderColor: '#f00', tag: '[OP]' },
      re: { color: '#0ff', borderColor: '#0ff', tag: '[RE]' },
      mop: { color: '#f0f', borderColor: '#f0f', tag: '[OP]' },
    },
    inlineNotifs: toggles,
    config: { channels: [{ id: 'c1', twitch: 'kripp' }] },
    irc: { channels: new Map([['kripp', twitch]]) },
    kickChat: null,
    channelYtMessages: new Map(),
  }
  const api = new Function(
    ...Object.keys(g),
    `${BLOCK}\nreturn { saveInlineNotif, restoreInlineNotifs, getQueue: () => saveQueue }`,
  )
  const out = api(...Object.values(g))
  return { ...out, store, twitch, g }
}

const post = (id, time) => ({ type: 'feed-post', base36_id: id, feedUser: 'u', text: 't', time, heat: 2 })

describe('inline notif persistence', () => {
  test('a saved row comes back at its timestamp, once', async () => {
    const { saveInlineNotif, restoreInlineNotifs, store, twitch } = load()
    saveInlineNotif('op', { ...post('00003q', Date.now() - 5000), inlineNotifType: 'op' })
    saveInlineNotif('op', post('00003q', Date.now() - 5000)) // duplicate delivery
    await new Promise((r) => setTimeout(r, 5))
    expect(store.hs_inline_notifs_v1.length).toBe(1)

    twitch.insertOrdered({ type: 'chat', time: Date.now() - 9000 })
    twitch.insertOrdered({ type: 'chat', time: Date.now() - 1000 })
    expect(await restoreInlineNotifs()).toBe(1)
    expect(twitch.items.map((m) => m.type)).toEqual(['chat', 'feed-post', 'chat'])
    expect(twitch.items[1].inlineNotifLabel).toBe('[OP]')
    expect(await restoreInlineNotifs()).toBe(0)
  })

  test('rows older than a week are dropped, and a type that is toggled off stays out', async () => {
    const { saveInlineNotif, restoreInlineNotifs, twitch, store } = load({
      toggles: { op: false, re: true, mop: true },
    })
    saveInlineNotif('re', post('00001a', Date.now() - 8 * 86400000))
    saveInlineNotif('op', post('00001b', Date.now() - 1000))
    await new Promise((r) => setTimeout(r, 5))
    expect(await restoreInlineNotifs()).toBe(0)
    expect(twitch.items.length).toBe(0)
    expect(store.hs_inline_notifs_v1.map((r) => r.msg.base36_id)).toEqual(['00001b'])
  })
})
