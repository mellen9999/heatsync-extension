// Threaded heatsync DMs arrive live: dm:message, dm:thread-update, dm:typing.
// Background shapes + forwards; the whispers tab decides what to draw.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const ROOT = join(import.meta.dir, '..')
const BG = bgSource()
const WHISPERS = readFileSync(join(ROOT, 'src', 'multichat', 'whispers.js'), 'utf8')
const SOCIAL = readFileSync(join(ROOT, 'src', 'multichat', 'social.js'), 'utf8')

function extractFn(code, name) {
  const start = code.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found — source drifted`)
  return code.slice(start, code.indexOf('\n}', start) + 2)
}

const shape = new Function(`${extractFn(BG, 'shapeDmThreadMessage')}; return shapeDmThreadMessage`)()
const frame = {
  type: 'dm:message',
  threadId: 't1',
  message: {
    id: '9',
    thread_id: 't1',
    sender_id: '42',
    content: 'hi\u0007 there',
    created_at: '2026-11-10T10:00:00.000Z',
    sender_username: 'alice',
    sender_display_name: 'Alice',
    sender_color: '#ff00ff',
  },
}

describe('shapeDmThreadMessage', () => {
  test('becomes the incoming-DM shape handleIncomingDm renders', () => {
    expect(shape(frame)).toEqual({
      id: '9',
      threadId: 't1',
      from_user_id: '42',
      from_display_name: 'Alice',
      from_color: '#ff00ff',
      content: 'hi  there',
      created_at: '2026-11-10T10:00:00.000Z',
    })
  })
  test('hostile fields are bounded or dropped, junk frames are null', () => {
    const w = shape({
      ...frame,
      message: { ...frame.message, sender_color: 'red; x', content: 'x'.repeat(5000), created_at: 'junk' },
    })
    expect(w.from_color).toBe('')
    expect(w.content).toHaveLength(2000)
    expect(w.created_at).toBe('')
    expect(shape({ ...frame, message: { ...frame.message, content: '  ' } })).toBeNull()
    expect(shape({ ...frame, message: { ...frame.message, sender_id: '' } })).toBeNull()
    expect(shape({ threadId: 't' })).toBeNull()
    expect(shape(null)).toBeNull()
  })
  test('falls back to the username when there is no display name', () => {
    expect(shape({ ...frame, message: { ...frame.message, sender_display_name: undefined } }).from_display_name).toBe(
      'alice',
    )
  })
})

describe('background wiring', () => {
  test('all three frames reach the tabs', () => {
    expect(BG).toMatch(
      /case 'dm:message': \{\s*const data = shapeDmThreadMessage\(msg\)\s*if \(data\) broadcastToTabs\(\{ type: 'dm_thread_message', data \}\)/,
    )
    expect(BG).toMatch(/case 'dm:thread-update':[\s\S]*type: 'dm_thread_update'/)
    expect(BG).toMatch(/case 'dm:typing':[\s\S]*type: 'dm_typing'/)
  })
  test('the panel listens for each', () => {
    expect(SOCIAL).toContain("msg.type === 'dm_thread_message'")
    expect(SOCIAL).toContain("msg.type === 'dm_thread_update'")
    expect(SOCIAL).toContain("msg.type === 'dm_typing'")
  })
})

describe('whispers tab appliers', () => {
  function rig({ tab = 'whispers', self = '7' } = {}) {
    const calls = { incoming: [], renders: 0 }
    const rows = []
    const el = {
      appendChild: (r) => rows.push(r),
      querySelectorAll: () => rows.filter((r) => !r.removed),
    }
    const env = {
      hsCurrentUserId: self,
      currentTab: tab,
      whisperDmsLoaded: true,
      whisperUsers: new Map([['hs:42', { displayName: 'Alice' }]]),
    }
    const timers = []
    const fns = new Function(
      'env',
      'calls',
      'el',
      'timers',
      `const document = { getElementById: () => el, createElement: () => ({ dataset: {}, remove() { this.removed = true } }) }
       const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
       const clearTimeout = () => {}
       const handleIncomingDm = (d) => calls.incoming.push(d)
       const renderWhispersTab = () => { calls.renders++ }
       const WHISPER_TYPING_MS = 6000
       const { whisperUsers } = env
       let hsCurrentUserId = env.hsCurrentUserId
       let currentTab = env.currentTab
       let whisperDmsLoaded = env.whisperDmsLoaded
       let _dmThreadRefreshTimer = null
       ${extractFn(WHISPERS, 'handleDmThreadMessage')}
       ${extractFn(WHISPERS, 'handleDmThreadUpdate')}
       ${extractFn(WHISPERS, 'handleDmTyping')}
       return { handleDmThreadMessage, handleDmThreadUpdate, handleDmTyping, loaded: () => whisperDmsLoaded }`,
    )(env, calls, el, timers)
    return { fns, calls, rows, timers }
  }
  test("someone else's message is ingested; your own echo is not", () => {
    const r = rig()
    r.fns.handleDmThreadMessage({ from_user_id: '42', content: 'x' })
    r.fns.handleDmThreadMessage({ from_user_id: '7', content: 'mine' })
    expect(r.calls.incoming.map((d) => d.content)).toEqual(['x'])
  })
  test('a thread update forgets the load latch and re-renders once, debounced', () => {
    const r = rig()
    r.fns.handleDmThreadUpdate()
    r.fns.handleDmThreadUpdate()
    expect(r.fns.loaded()).toBe(false)
    expect(r.calls.renders).toBe(0)
    r.timers.at(-1).fn()
    expect(r.calls.renders).toBe(1)
  })
  test('a thread update off the whispers tab only forgets the latch', () => {
    const r = rig({ tab: 'chat' })
    r.fns.handleDmThreadUpdate()
    expect(r.fns.loaded()).toBe(false)
    expect(r.timers).toHaveLength(0)
  })
  test('typing draws one self-clearing row for a known person, nothing for yourself or a stranger', () => {
    const r = rig()
    r.fns.handleDmTyping('42')
    expect(r.rows.map((x) => x.textContent)).toEqual(['Alice …'])
    r.timers.at(-1).fn()
    expect(r.rows[0].removed).toBe(true)
    r.fns.handleDmTyping('7')
    r.fns.handleDmTyping('999')
    expect(r.rows).toHaveLength(1)
  })
  test('typing off the whispers tab draws nothing', () => {
    const r = rig({ tab: 'chat' })
    r.fns.handleDmTyping('42')
    expect(r.rows).toHaveLength(0)
  })
})
