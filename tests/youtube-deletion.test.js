import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A youtube message a mod deleted — and every message by a banned author —
 * must stop looking live.
 *
 * The server sends `youtube:delete` to every socket subscribed to a video's
 * chat, commented "clients match by innertube id or (for bans)
 * authorChannelId". The extension had no case for it at all, so removed
 * messages simply stayed on screen. Found by diffing the two ends of the
 * websocket contract (tests/ws-contract.test.js).
 *
 * The routine is lifted from source and run against a fake DOM, the idiom
 * player-guard.test.js uses — social.js is a bundle fragment and cannot be
 * imported on its own.
 */

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')

function lift(name) {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} not found`)
  let depth = 0
  for (let i = SRC.indexOf('{', at); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error('unbalanced')
}

function build({ buffers, queues, rows, dim = true }) {
  const made = rows.map((r) => ({
    dataset: { msgId: r.id || '', msgUser: r.user || '', msgPlatform: r.platform || 'youtube' },
    classList: {
      _s: new Set(),
      add(c) {
        this._s.add(c)
      },
      contains(c) {
        return this._s.has(c)
      },
    },
    title: '',
    removed: false,
    remove() {
      this.removed = true
    },
  }))
  const doc = { getElementById: () => ({ querySelectorAll: () => made }) }
  const channelYtMessages = new Map(Object.entries(buffers))
  const _ytPaceQueue = new Map(Object.entries(queues))
  // Stands in for main.js's markClearedRow — same two branches. Youtube used
  // to patch the class directly and so ignored `hs_dim_timeouts` entirely;
  // routing it through the shared helper is what this double models.
  const markClearedRow = (row, title) => {
    if (!row) return
    if (!dim) {
      row.remove()
      return
    }
    row.classList.add('hs-mc-msg-cleared')
    if (title) row.title = title
  }
  const fn = new Function(
    'channelYtMessages',
    '_ytPaceQueue',
    'document',
    'markClearedRow',
    `${lift('applyYtDeletion')}; return applyYtDeletion`,
  )(channelYtMessages, _ytPaceQueue, doc, markClearedRow)
  return { fn, made, channelYtMessages, _ytPaceQueue }
}

const msg = (o) => ({ user: 'someone', ...o })

describe('youtube deletion', () => {
  test('clears a buffered message by its innertube id', () => {
    const t = build({ buffers: { c1: [msg({ id: 'A' }), msg({ id: 'B' })] }, queues: {}, rows: [] })
    t.fn({ messageIds: ['A'] })
    const [a, b] = t.channelYtMessages.get('c1')
    expect(a.cleared).toBe(true)
    expect(a.clearedReason).toBe('deleted')
    expect(b.cleared).toBeUndefined()
  })

  test('clears every message by a banned author, via the namespaced paint uid', () => {
    const t = build({
      buffers: { c1: [msg({ id: 'A', hsPaintUid: 'yt_UC123' }), msg({ id: 'B', hsPaintUid: 'yt_UC999' })] },
      queues: {},
      rows: [],
    })
    t.fn({ authorChannelIds: ['UC123'] })
    const [a, b] = t.channelYtMessages.get('c1')
    expect(a.cleared).toBe(true)
    expect(b.cleared).toBeUndefined()
  })

  test('clears a message still waiting in the pace queue', () => {
    // Deleted before it drained — otherwise it arrives on screen moments later
    // looking untouched, which is the worst version of this bug.
    const t = build({ buffers: {}, queues: { c1: [msg({ id: 'A' })] }, rows: [] })
    t.fn({ messageIds: ['A'] })
    expect(t._ytPaceQueue.get('c1')[0].cleared).toBe(true)
  })

  test('patches rows already on screen, by id and by banned author', () => {
    const t = build({
      buffers: { c1: [msg({ id: 'A', user: 'Bob', hsPaintUid: 'yt_UC1' })] },
      queues: {},
      rows: [
        { id: 'A', user: 'Bob' },
        { id: 'Z', user: 'bob' },
        { id: 'Q', user: 'other' },
      ],
    })
    t.fn({ authorChannelIds: ['UC1'] })
    expect(t.made[0].classList.contains('hs-mc-msg-cleared')).toBe(true)
    expect(t.made[1].classList.contains('hs-mc-msg-cleared')).toBe(true) // same author, other row
    expect(t.made[2].classList.contains('hs-mc-msg-cleared')).toBe(false)
  })

  test('never touches another platform', () => {
    const t = build({ buffers: {}, queues: {}, rows: [{ id: 'A', user: 'bob', platform: 'twitch' }] })
    t.fn({ messageIds: ['A'] })
    expect(t.made[0].classList.contains('hs-mc-msg-cleared')).toBe(false)
  })

  test('an empty payload does nothing', () => {
    const t = build({ buffers: { c1: [msg({ id: 'A' })] }, queues: {}, rows: [{ id: 'A' }] })
    t.fn({})
    expect(t.channelYtMessages.get('c1')[0].cleared).toBeUndefined()
    expect(t.made[0].classList.contains('hs-mc-msg-cleared')).toBe(false)
  })
})

describe('youtube deletion honours dim-timeouts', () => {
  // youtube's deletion path was added after the setting and patched the dim
  // class straight onto the row, so `dim timed-out messages: off` did nothing
  // on youtube while twitch and kick both respected it. Both polarities, since
  // "off" is the half that was never implemented anywhere in the overlay.
  const rows = [
    { id: 'A', user: 'someone' },
    { id: 'B', user: 'other' },
  ]

  test('dim ON: the target is dimmed and left on screen', () => {
    const { fn, made } = build({ buffers: {}, queues: {}, rows, dim: true })
    fn({ messageIds: ['A'] })
    expect(made[0].classList.contains('hs-mc-msg-cleared')).toBe(true)
    expect(made[0].removed).toBe(false)
    expect(made[1].classList.contains('hs-mc-msg-cleared')).toBe(false)
    expect(made[1].removed).toBe(false)
  })

  test('dim OFF: the target is removed, not left fully readable', () => {
    const { fn, made } = build({ buffers: {}, queues: {}, rows, dim: false })
    fn({ messageIds: ['A'] })
    expect(made[0].removed).toBe(true)
    expect(made[0].classList.contains('hs-mc-msg-cleared')).toBe(false)
    expect(made[1].removed).toBe(false)
  })
})
