/**
 * A tab lights up "unread" only for something said in that channel's chat. The
 * OP/RE rows (and receipts) are copied into every channel's buffer, and used to
 * count — so a channel nobody had spoken in kept showing unread after a reload.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const fnSrc = SRC.slice(
  SRC.indexOf('function applyUnreadIndicatorForTab'),
  SRC.indexOf('// YouTube global state (per-channel only now'),
)

function run(buffer) {
  const classes = new Set()
  const tabEl = { dataset: { tab: 'dellor' }, classList: { add: (c) => classes.add(c) } }
  const buf = { getAll: () => buffer }
  const fn = new Function(
    'currentTab',
    'mcReservedTabIds',
    'tabSeenAt',
    'getChannelById',
    'irc',
    'kickChat',
    'channelYtMessages',
    'isMention',
    `${fnSrc}\nreturn applyUnreadIndicatorForTab`,
  )(
    'live',
    () => [],
    { dellor: 1000 },
    () => ({ twitch: 'dellor' }),
    { channels: new Map([['dellor', buf]]) },
    null,
    new Map(),
    () => false,
  )
  fn(tabEl)
  return classes
}

describe('applyUnreadIndicatorForTab', () => {
  test('an OP row newer than the last visit does not make the tab unread', () => {
    const cls = run([
      { time: 500, user: 'a' },
      { time: 2000, type: 'feed-post', inlineNotifType: 'op' },
    ])
    expect(cls.has('has-new')).toBe(false)
  })

  test('a real chat message newer than the last visit still does', () => {
    const cls = run([
      { time: 2000, type: 'feed-post', inlineNotifType: 'op' },
      { time: 3000, user: 'someone' },
    ])
    expect(cls.has('has-new')).toBe(true)
  })
})
