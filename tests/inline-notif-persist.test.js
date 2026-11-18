import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainSource } from './main-src.js'

/**
 * Inline [OP]/[RE] rows survive an ext reload: saveInlineNotif writes them to
 * storage, restoreInlineNotifs puts them back into every channel buffer at
 * their real time, once. The shipped source runs against stubbed globals.
 */
const SRC = mainSource()
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
    t: (k) => k,
    drops: { n: 0 },
    _dropAllTabCaches: () => g.drops.n++,
    onScreen: [],
    document: { querySelectorAll: () => g.onScreen },
  }
  const api = new Function(
    ...Object.keys(g),
    `${BLOCK}\nreturn { saveInlineNotif, restoreInlineNotifs, dropInlinePost, getQueue: () => saveQueue }`,
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

// The author deleted the post. Its row in chat was a copy the delete never reached: it stayed
// readable in every channel tab, and the saved copy drew it again on each reload for a week.
describe('a deleted post leaves chat', () => {
  const row = (id) => {
    const body = { textContent: 'the post' }
    const tag = { removed: false, remove: () => (tag.removed = true) }
    return { dataset: { msgId: id }, body, tag, querySelector: (sel) => (sel === '.hs-feed-body' ? body : tag) }
  }

  test('every copy is emptied where it stands, the saved one is dropped, and a reload draws nothing', async () => {
    const { saveInlineNotif, dropInlinePost, store, twitch, g } = load()
    g.channelYtMessages.set('c1', [])
    const live = { ...post('00003q', Date.now() - 5000), mediaTag: 'img', mediaSrc: 'https://x/y.png', emote_refs: [1] }
    const other = post('00003r', Date.now() - 4000)
    for (const m of [live, other]) {
      saveInlineNotif('op', m)
      twitch.insertOrdered(m)
      g.channelYtMessages.get('c1').push({ ...m })
    }
    await new Promise((r) => setTimeout(r, 5))
    const mine = row('00003q')
    const theirs = row('00003r')
    g.onScreen.push(mine, theirs)

    await dropInlinePost('00003q')
    // the buffers keep the row (rows never move), with nothing of the post left in it
    expect(twitch.items.map((m) => m.base36_id)).toEqual(['00003q', '00003r'])
    for (const m of [twitch.items[0], g.channelYtMessages.get('c1')[0]]) {
      expect(m.gone).toBe(true)
      expect(m.text).toBe('')
      expect([m.mediaTag, m.mediaSrc, m.emote_refs]).toEqual([null, null, null])
    }
    expect(twitch.items[1].text).toBe('t')
    expect(twitch.items[1].gone).toBeUndefined()
    // on screen, and in tabs drawn earlier
    expect(mine.body.textContent).toBe('mc_profile_deleted_message')
    expect(mine.tag.removed).toBe(true)
    expect(theirs.body.textContent).toBe('the post')
    expect(theirs.tag.removed).toBe(false)
    expect(g.drops.n).toBe(1)
    // and it is not saved any more
    expect(store.hs_inline_notifs_v1.map((r) => r.msg.base36_id)).toEqual(['00003r'])
    const fresh = load()
    Object.assign(fresh.store, store)
    expect(await fresh.restoreInlineNotifs()).toBe(1)
    expect(fresh.twitch.items.map((m) => m.base36_id)).toEqual(['00003r'])
  })

  test('a save still in flight when the delete arrives does not bring it back', async () => {
    const { saveInlineNotif, dropInlinePost, store } = load()
    saveInlineNotif('op', post('00003q', Date.now()))
    await dropInlinePost('00003q')
    expect(store.hs_inline_notifs_v1 || []).toEqual([])
  })

  test('the row builder draws an emptied post as deleted, never its text', () => {
    expect(SRC).toContain(
      "const content = m.gone ? escapeHtml(t('mc_profile_deleted_message')) : renderFeedContent(m.text, m.emote_refs)",
    )
    const social = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
    const del = social.slice(social.indexOf("if (msg.type === 'message-deleted' && msg.data) {"))
    expect(del.slice(0, 400)).toContain('dropInlinePost(id)')
  })
})
