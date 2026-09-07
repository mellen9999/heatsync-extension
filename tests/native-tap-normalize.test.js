/**
 * Unit tests for src/multichat/native-tap.js — _tapToMsg().
 *
 * Twitch starves third-party IRC delivery on flagged IPs, so the native tap
 * mines the page's OWN chat-line React fiber for the message object and
 * normalizes it into the same shape parseIrcLine() produces (see irc.js).
 * This is the closest thing this codebase has to a platform-adapter
 * "normalize raw platform payload → internal msg" pure function — no DOM,
 * no chrome APIs, just object shape wrangling on data Twitch's react tree
 * handed us (which itself is undocumented and drifts across builds, hence
 * all the defensive fallbacks this test exercises).
 */

import { expect, test } from 'bun:test'
import { _tapToMsg } from '../src/multichat/native-tap.js'

test('_tapToMsg: basic message with plain-string messageParts', () => {
  const m = {
    id: 'msg-1',
    user: { userDisplayName: 'Alice', userLogin: 'alice', userID: '123', color: '#ff0000' },
    messageParts: [{ content: 'hello world' }],
  }
  const msg = _tapToMsg(m, 'somechannel')
  expect(msg.user).toBe('Alice')
  expect(msg.login).toBe('alice')
  expect(msg.userId).toBe('123')
  expect(msg.text).toBe('hello world')
  expect(msg.color).toBe('#ff0000')
  expect(msg.channel).toBe('somechannel')
  expect(msg.id).toBe('msg-1')
  expect(msg.fromNativeTap).toBe(true)
  expect(msg.replyTo).toBeNull()
})

test('_tapToMsg: falls back to displayName when userDisplayName missing', () => {
  const m = { id: '1', user: { displayName: 'Bob' }, messageParts: [{ content: 'hi' }] }
  expect(_tapToMsg(m, 'chan').user).toBe('Bob')
})

test("_tapToMsg: no display name at all → null (can't render an anonymous native message)", () => {
  const m = { id: '1', user: {}, messageParts: [{ content: 'hi' }] }
  expect(_tapToMsg(m, 'chan')).toBeNull()
})

test('_tapToMsg: login falls back to displayName lowercased when userLogin missing', () => {
  const m = { id: '1', user: { userDisplayName: 'MixedCase' }, messageParts: [{ content: 'hi' }] }
  expect(_tapToMsg(m, 'chan').login).toBe('mixedcase')
})

test('_tapToMsg: emote part builds text via alt + registers twitchEmotes CDN url', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: 'say ' }, { content: { alt: 'Kappa', emoteID: '25' } }, { content: ' now' }],
  }
  const msg = _tapToMsg(m, 'chan')
  expect(msg.text).toBe('say Kappa now')
  expect(msg.twitchEmotes).toEqual({ Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' })
})

test('_tapToMsg: repeated emote alt only registers the url once', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [
      { content: { alt: 'Kappa', emoteID: '25' } },
      { content: ' ' },
      { content: { alt: 'Kappa', emoteID: '999' } }, // different id, same name — first wins
    ],
  }
  const msg = _tapToMsg(m, 'chan')
  expect(msg.twitchEmotes.Kappa).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0')
})

test('_tapToMsg: mention part (recipient) prefixes @ ', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: { recipient: 'Bob' } }, { content: ' hey' }],
  }
  expect(_tapToMsg(m, 'chan').text).toBe('@Bob hey')
})

test('_tapToMsg: mention part (displayName field) prefixes @ ', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: { displayName: 'Carl' } }],
  }
  expect(_tapToMsg(m, 'chan').text).toBe('@Carl')
})

test('_tapToMsg: object part with plain .text field is appended', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: { text: 'plain object text' } }],
  }
  expect(_tapToMsg(m, 'chan').text).toBe('plain object text')
})

test('_tapToMsg: object part with .url field is appended', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: { url: 'https://example.com/x' } }],
  }
  expect(_tapToMsg(m, 'chan').text).toBe('https://example.com/x')
})

test('_tapToMsg: falls back to messageBody when messageParts absent', () => {
  const m = { id: '1', user: { userDisplayName: 'Alice' }, messageBody: 'legacy body text' }
  expect(_tapToMsg(m, 'chan').text).toBe('legacy body text')
})

test('_tapToMsg: no resolvable text at all → null', () => {
  const m = { id: '1', user: { userDisplayName: 'Alice' } }
  expect(_tapToMsg(m, 'chan')).toBeNull()
})

test('_tapToMsg: badges as array of {setID, version} joins to "id/version" csv', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    badges: [
      { setID: 'moderator', version: '1' },
      { setID: 'subscriber', version: '12' },
    ],
    messageParts: [{ content: 'hi' }],
  }
  expect(_tapToMsg(m, 'chan').badges).toBe('moderator/1,subscriber/12')
})

test('_tapToMsg: badges as array missing version defaults to /1', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    badges: [{ setID: 'vip' }],
    messageParts: [{ content: 'hi' }],
  }
  expect(_tapToMsg(m, 'chan').badges).toBe('vip/1')
})

test('_tapToMsg: badges as plain object map joins to csv', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice', badges: { moderator: '1' } },
    messageParts: [{ content: 'hi' }],
  }
  expect(_tapToMsg(m, 'chan').badges).toBe('moderator/1')
})

test('_tapToMsg: subscriber badge sets subMonths from badge string', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    badges: [{ setID: 'subscriber', version: '14' }],
    messageParts: [{ content: 'hi' }],
  }
  expect(_tapToMsg(m, 'chan').subMonths).toBe(14)
})

test('_tapToMsg: messageType 1 or isAction flag sets isAction', () => {
  const base = { id: '1', user: { userDisplayName: 'Alice' }, messageParts: [{ content: '/me waves' }] }
  expect(_tapToMsg({ ...base, messageType: 1 }, 'chan').isAction).toBe(true)
  expect(_tapToMsg({ ...base, isAction: true }, 'chan').isAction).toBe(true)
  expect(_tapToMsg(base, 'chan').isAction).toBeUndefined()
})

test('_tapToMsg: numeric timestamp in ms (>1e12) is preserved verbatim', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: 'hi' }],
    timestamp: 1700000000000,
  }
  expect(_tapToMsg(m, 'chan').time).toBe(1700000000000)
})

test('_tapToMsg: implausible small timestamp (not real ms epoch) falls back to Date.now()', () => {
  const m = { id: '1', user: { userDisplayName: 'Alice' }, messageParts: [{ content: 'hi' }], timestamp: 42 }
  const before = Date.now()
  const msg = _tapToMsg(m, 'chan')
  expect(msg.time).toBeGreaterThanOrEqual(before)
})

test('_tapToMsg: missing color defaults to #fff', () => {
  const m = { id: '1', user: { userDisplayName: 'Alice' }, messageParts: [{ content: 'hi' }] }
  expect(_tapToMsg(m, 'chan').color).toBe('#fff')
})

test('_tapToMsg: userId coerced to string, defaults to empty string', () => {
  const withId = { id: '1', user: { userDisplayName: 'A', userID: 42 }, messageParts: [{ content: 'hi' }] }
  expect(_tapToMsg(withId, 'chan').userId).toBe('42')
  const noId = { id: '1', user: { userDisplayName: 'A' }, messageParts: [{ content: 'hi' }] }
  expect(_tapToMsg(noId, 'chan').userId).toBe('')
})

test('_tapToMsg: messageParts nested one level under m.message.messageParts is also read', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    message: { messageParts: [{ content: 'nested text' }] },
  }
  expect(_tapToMsg(m, 'chan').text).toBe('nested text')
})

// D5: the shared-chat chip needs the partner channel's numeric id to resolve
// a login — not just the sharedChat boolean.
test('_tapToMsg: differing roomID/sourceRoomID sets sharedChat and sourceRoomId', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: 'hi' }],
    roomID: '111',
    sourceRoomID: '222',
  }
  const msg = _tapToMsg(m, 'chan')
  expect(msg.sharedChat).toBe(true)
  expect(msg.sourceRoomId).toBe('222')
})

test('_tapToMsg: the roomId/sourceRoomId casing variant is also read', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: 'hi' }],
    roomId: 111,
    sourceRoomId: 333,
  }
  const msg = _tapToMsg(m, 'chan')
  expect(msg.sharedChat).toBe(true)
  expect(msg.sourceRoomId).toBe('333')
})

test('_tapToMsg: matching room ids is not shared chat', () => {
  const m = {
    id: '1',
    user: { userDisplayName: 'Alice' },
    messageParts: [{ content: 'hi' }],
    roomID: '111',
    sourceRoomID: '111',
  }
  const msg = _tapToMsg(m, 'chan')
  expect(msg.sharedChat).toBeUndefined()
  expect(msg.sourceRoomId).toBeUndefined()
})
