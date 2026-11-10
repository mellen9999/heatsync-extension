// kick-native-tap.js pure mappers — kick frame payloads → the EXACT shapes
// the kick pipeline already consumes. Shape parity with background.js's
// _kpHandleChatEvent/_kpHandleModEvent is the contract: same fields, same
// defaults, same id, so the overlay renders tap-fed messages identically and
// KickChat's id-dedup drops relay/tap doubles.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'kick-native-tap.js'), 'utf8')

function extractFn(name) {
  const marker = `function ${name}(`
  const start = SRC.indexOf(marker)
  if (start === -1) throw new Error(`extractFn: "${name}" not found — source drifted, update this test`)
  const end = SRC.indexOf('\n}', start)
  if (end === -1) throw new Error(`extractFn: "${name}" has no closing brace`)
  return SRC.slice(start, end + 2)
}

const { kickTapChatToPayload, kickTapModToMessage } = new Function(
  `${extractFn('kickTapChatToPayload')}\n${extractFn('kickTapModToMessage')}\nreturn { kickTapChatToPayload, kickTapModToMessage }`,
)()

describe('kickTapChatToPayload', () => {
  const ev = {
    id: '8fc26b02-80b1-4db7-a20c-5557846e2ec9',
    content: 'hello [emote:37227:LULW]',
    created_at: '2026-07-17T10:00:00.000Z',
    sender: {
      id: 28318371,
      username: 'chatter1',
      identity: { color: '#ff9d00', badges: [{ type: 'moderator', text: 'Moderator' }] },
    },
  }
  test('maps the full relay-parity shape', () => {
    const p = kickTapChatToPayload(ev, 'somechannel')
    expect(p).toEqual({
      platform: 'kick',
      channel: 'somechannel',
      username: 'chatter1',
      displayName: 'chatter1',
      senderId: 28318371,
      content: 'hello [emote:37227:LULW]',
      color: '#ff9d00',
      badges: [{ type: 'moderator', text: 'Moderator' }],
      timestamp: Date.parse('2026-07-17T10:00:00.000Z'),
      id: '8fc26b02-80b1-4db7-a20c-5557846e2ec9',
      replyTo: null,
    })
  })
  test('reply metadata maps to the relay replyTo shape', () => {
    const p = kickTapChatToPayload(
      {
        ...ev,
        metadata: {
          original_sender: { username: 'op_user' },
          original_message: { id: 'orig-id', content: 'original text' },
        },
      },
      'somechannel',
    )
    expect(p.replyTo).toEqual({ username: 'op_user', content: 'original text', id: 'orig-id' })
  })
  test('defaults: missing sender/color/created_at degrade like the BG tap', () => {
    const p = kickTapChatToPayload({ id: 'x', content: 'hi' }, 'ch')
    expect(p.username).toBe('unknown')
    expect(p.color).toBe('#53fc18')
    expect(p.senderId).toBeNull()
    expect(typeof p.timestamp).toBe('number')
  })
  test('rejects garbage: null ev, missing slug, empty ev', () => {
    expect(kickTapChatToPayload(null, 'ch')).toBeNull()
    expect(kickTapChatToPayload(ev, '')).toBeNull()
    expect(kickTapChatToPayload({}, 'ch')).toBeNull()
  })
})

describe('kickTapModToMessage', () => {
  test('MessageDeletedEvent → delete action with target id', () => {
    const m = kickTapModToMessage('App\\Events\\MessageDeletedEvent', { message: { id: 'msg-1' } }, 'ch')
    expect(m).toEqual({ type: 'kick_moderation', action: 'delete', channel: 'ch', targetMsgId: 'msg-1' })
  })
  test('UserBannedEvent with future expires_at → timeout with duration', () => {
    const exp = new Date(Date.now() + 60000).toISOString()
    const m = kickTapModToMessage(
      'App\\Events\\UserBannedEvent',
      { user: { id: 5, username: 'baduser' }, expires_at: exp },
      'ch',
    )
    expect(m.action).toBe('timeout')
    expect(m.targetUser).toBe('baduser')
    expect(m.targetUserId).toBe('5')
    expect(m.banDuration).toBeGreaterThan(0)
    expect(m.banDuration).toBeLessThanOrEqual(60)
  })
  test('UserBannedEvent without expiry → permanent ban', () => {
    const m = kickTapModToMessage('App\\Events\\UserBannedEvent', { user: { username: 'baduser' } }, 'ch')
    expect(m.action).toBe('ban')
    expect(m.banDuration).toBe(0)
  })
  test('UserUnbannedEvent → unban', () => {
    const m = kickTapModToMessage('App\\Events\\UserUnbannedEvent', { user: { username: 'gooduser' } }, 'ch')
    expect(m).toEqual({ type: 'kick_moderation', action: 'unban', channel: 'ch', targetUser: 'gooduser' })
  })
  test('rejects: unknown event, missing targets, null ev', () => {
    expect(kickTapModToMessage('App\\Events\\SomethingElse', { user: { username: 'x' } }, 'ch')).toBeNull()
    expect(kickTapModToMessage('App\\Events\\MessageDeletedEvent', {}, 'ch')).toBeNull()
    expect(kickTapModToMessage('App\\Events\\UserBannedEvent', {}, 'ch')).toBeNull()
    expect(kickTapModToMessage('App\\Events\\UserBannedEvent', null, 'ch')).toBeNull()
  })
})
