/**
 * chatLogsLive — a line the person sends while their logs are open lands at the
 * top of the list; anything else (other person, other platform, other channel,
 * a search showing, a notice) is ignored.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'chat-logs.js'), 'utf8')
const start = SRC.indexOf('function chatLogsLive(msg)')
const end = SRC.indexOf('\nasync function refreshChatLogs')
const BODY = SRC.slice(start, end)

function make(state) {
  const rendered = []
  const list = {
    scrollTop: 0,
    firstChild: null,
    querySelector: () => null,
    insertBefore: (row) => rendered.unshift(row),
  }
  const doc = { querySelector: () => list }
  let fullRenders = 0
  const fn = new Function(
    'activeChatLogs',
    'document',
    'renderChatLogRow',
    'renderChatLogsView',
    `${BODY}\nreturn chatLogsLive`,
  )(
    state,
    doc,
    (r) => ({ r, offsetHeight: 20 }),
    () => {
      fullRenders++
    },
  )
  return { fn, rendered, list, renders: () => fullRenders }
}

const base = () => ({ username: 'ennortix', platform: 'twitch', channel: null, query: '', rows: [] })
const msg = (o = {}) => ({ user: 'ennortix', text: 'hello', channel: 'nl_kripp', time: 1700000000000, ...o })

describe('chatLogsLive', () => {
  test('their own line goes to the top of the rows and the list', () => {
    const st = base()
    st.rows.push({ message: 'older' })
    const t = make(st)
    t.fn(msg())
    expect(st.rows[0]).toMatchObject({
      message: 'hello',
      username: 'ennortix',
      channel: 'nl_kripp',
      live: true,
      platform: 'twitch',
    })
    expect(st.rows).toHaveLength(2)
    expect(t.rendered).toHaveLength(1)
  })

  test('someone else, another platform, another channel, a search, a notice: ignored', () => {
    const st = base()
    st.channel = 'nl_kripp'
    const t = make(st)
    t.fn(msg({ user: 'someoneelse' }))
    t.fn(msg({ platform: 'kick' }))
    t.fn(msg({ channel: 'other' }))
    t.fn(msg({ type: 'notice' }))
    t.fn(msg({ isHistory: true }))
    t.fn(msg({ text: '' }))
    st.query = 'abc'
    t.fn(msg())
    expect(st.rows).toHaveLength(0)
    expect(t.rendered).toHaveLength(0)
  })

  test('a repeat of the same live line is not added twice', () => {
    const st = base()
    const t = make(st)
    t.fn(msg())
    t.fn(msg())
    expect(st.rows).toHaveLength(1)
  })

  test('yt maps to youtube and the row count stays capped', () => {
    const st = { ...base(), platform: 'youtube' }
    st.rows = Array.from({ length: 500 }, (_, i) => ({ message: `m${i}` }))
    const t = make(st)
    t.fn(msg({ platform: 'yt' }))
    expect(st.rows).toHaveLength(500)
    expect(st.rows[0].platform).toBe('youtube')
  })

  test('nothing open means nothing happens', () => {
    const t = make(null)
    expect(() => t.fn(msg())).not.toThrow()
  })
})
