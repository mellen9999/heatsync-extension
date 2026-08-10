/**
 * Unit tests for src/multichat/irc.js — Twitch IRC line parser.
 *
 * parseTags / parseTwitchEmotesTag / parseIrcLine / CircularBuffer are pure
 * (or near-pure — parseIrcLine calls the bundle-global `t()` and
 * `sanitizeColor()` helpers, which in the real bundle come from
 * src/lib/browser-api.js and main.js respectively). We stub both on
 * globalThis before each test, matching the pattern in user-notes.test.js.
 *
 * The IRC/KickChat classes (stateful, chrome.runtime-driven) are intentionally
 * NOT tested here — they need a full chrome.* stub harness that doesn't exist
 * yet and isn't worth building for this pass. parseIrcLine is the actual
 * bug-prone surface (regex + tag decoding on untrusted server input).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { CircularBuffer, parseIrcLine, parseTags, parseTwitchEmotesTag } from '../src/multichat/irc.js'

beforeEach(() => {
  globalThis.sanitizeColor = (c) => c || '#fff'
  globalThis.t = (key, subs) => (Array.isArray(subs) ? `${key}:${subs.join(',')}` : key)
})
afterEach(() => {
  globalThis.sanitizeColor = undefined
  globalThis.t = undefined
})

// ── parseTags ─────────────────────────────────────────────────────────────

test('parseTags: splits key=value pairs on ;', () => {
  const tags = parseTags('color=#FF0000;display-name=Alice;user-id=123')
  expect(tags.color).toBe('#FF0000')
  expect(tags['display-name']).toBe('Alice')
  expect(tags['user-id']).toBe('123')
})

test('parseTags: flag tag with no = gets empty string', () => {
  const tags = parseTags('mod;color=#FF0000')
  expect(tags.mod).toBe('')
  expect(tags.color).toBe('#FF0000')
})

test('parseTags: tag with = but empty value gets empty string', () => {
  const tags = parseTags('display-name=;color=#fff')
  expect(tags['display-name']).toBe('')
})

test('parseTags: value containing = is preserved (only first = splits)', () => {
  const tags = parseTags('badge-info=subscriber/1=x;color=#fff')
  expect(tags['badge-info']).toBe('subscriber/1=x')
})

test('parseTags: raw escaped values are NOT unescaped (caller responsibility)', () => {
  // Twitch escapes \s (space), \: (semicolon), \\ (backslash), \r, \n in tag values.
  // parseTags itself does not decode these — verifying current (real) behavior
  // so regressions in either direction are caught.
  const tags = parseTags('system-msg=hello\\sworld\\:test')
  expect(tags['system-msg']).toBe('hello\\sworld\\:test')
})

test('parseTags: single empty part produces empty-string key', () => {
  const tags = parseTags('')
  expect(tags['']).toBe('')
})

// ── parseTwitchEmotesTag ──────────────────────────────────────────────────

test('parseTwitchEmotesTag: null/empty tag returns null', () => {
  expect(parseTwitchEmotesTag(null, 'hello')).toBeNull()
  expect(parseTwitchEmotesTag('', 'hello')).toBeNull()
})

test('parseTwitchEmotesTag: single emote maps name to CDN url', () => {
  // "Kappa" at positions 0-4 (inclusive end) in "Kappa test"
  const out = parseTwitchEmotesTag('25:0-4', 'Kappa test')
  expect(out).toEqual({ Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' })
})

test('parseTwitchEmotesTag: multiple positions for same emote id, only first position used for name extraction', () => {
  const out = parseTwitchEmotesTag('25:0-4,6-10', 'Kappa Kappa')
  expect(out.Kappa).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0')
})

test('parseTwitchEmotesTag: multiple distinct emotes separated by /', () => {
  const out = parseTwitchEmotesTag('25:0-4/1902:6-13', 'Kappa PogChamp')
  expect(Object.keys(out).sort()).toEqual(['Kappa', 'PogChamp'])
})

test('parseTwitchEmotesTag: malformed part without colon is skipped', () => {
  const out = parseTwitchEmotesTag('nocolonhere/25:0-4', 'Kappa')
  expect(out).toEqual({ Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' })
})

test('parseTwitchEmotesTag: non-numeric range yields NaN and is skipped', () => {
  const out = parseTwitchEmotesTag('25:a-b', 'Kappa')
  expect(out).toBeNull()
})

test('parseTwitchEmotesTag: BMP unicode text — code-point and code-unit indices coincide', () => {
  // "❤️Kappa" — heart+VS16 is 2 code units AND 2 code points, Kappa starts at 2
  const text = '❤️Kappa'
  const out = parseTwitchEmotesTag('25:2-6', text)
  expect(out.Kappa).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0')
})

test('parseTwitchEmotesTag: astral emoji before emote — indices are CODE POINTS, not UTF-16 units', () => {
  // "😂 Kappa" — 😂 is 1 code point (2 UTF-16 units). Twitch counts code
  // points: 😂=0, space=1, Kappa=2-6. A UTF-16 slice(2, 7) would yield
  // "\uDE02 Kap" — the pre-fix bug.
  const out = parseTwitchEmotesTag('25:2-6', '😂 Kappa')
  expect(out).toEqual({ Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' })
})

test('parseTwitchEmotesTag: multiple astral chars + multiple emotes all resolve by code point', () => {
  // code points: 😂=0, 🎉=1, space=2, Kappa=3-7, space=8, PogChamp=9-16
  const out = parseTwitchEmotesTag('25:3-7/1902:9-16', '😂🎉 Kappa PogChamp')
  expect(Object.keys(out).sort()).toEqual(['Kappa', 'PogChamp'])
})

test('parseTwitchEmotesTag: astral chars AFTER the emote do not affect its range', () => {
  const out = parseTwitchEmotesTag('25:0-4', 'Kappa 😂😂')
  expect(out.Kappa).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0')
})

test('parseTwitchEmotesTag: all positions out of range → no emotes found → null', () => {
  const out = parseTwitchEmotesTag('25:100-104', 'short')
  expect(out).toBeNull()
})

// ── parseIrcLine: PRIVMSG ─────────────────────────────────────────────────

test('parseIrcLine: PRIVMSG basic shape', () => {
  const raw =
    '@badge-info=;badges=broadcaster/1;color=#FF0000;display-name=Alice;emotes=;first-msg=0;id=abc-123;mod=0;room-id=1;subscriber=0;tmi-sent-ts=1700000000000;turbo=0;user-id=1;user-type= :alice!alice@alice.tmi.twitch.tv PRIVMSG #alice :hello world'
  const msg = parseIrcLine(raw, 'alice')
  expect(msg.user).toBe('Alice')
  expect(msg.login).toBe('alice')
  expect(msg.text).toBe('hello world')
  expect(msg.channel).toBe('alice')
  expect(msg.id).toBe('abc-123')
  expect(msg.time).toBe(1700000000000)
  expect(msg.userId).toBe('1')
})

test('parseIrcLine: PRIVMSG falls back to display-name when no login prefix match', () => {
  const raw = '@display-name=WeirdあName PRIVMSG #chan :hi'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.login).toBe('weirdあname')
})

test('parseIrcLine: PRIVMSG login is lowercase and independent of display-name casing', () => {
  const raw = '@display-name=AlIcE :AlIcE!AlIcE@AlIcE.tmi.twitch.tv PRIVMSG #chan :hi'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.user).toBe('AlIcE')
  expect(msg.login).toBe('alice')
})

test('parseIrcLine: /me ACTION is unwrapped and isAction set', () => {
  const raw = '@display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :ACTION waves hello'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.isAction).toBe(true)
  expect(msg.text).toBe('waves hello')
})

test('parseIrcLine: /me ACTION without trailing \\x01 still strips prefix', () => {
  const raw = '@display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :ACTION waves hello'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.isAction).toBe(true)
  expect(msg.text).toBe('waves hello')
})

test('parseIrcLine: plain message starting with literal word ACTION (no \\x01) is not an action', () => {
  const raw = '@display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :ACTION waves hello'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.isAction).toBeUndefined()
  expect(msg.text).toBe('ACTION waves hello')
})

test('parseIrcLine: reply-parent tags build replyTo object with \\s unescaped', () => {
  const raw =
    '@display-name=Bob;reply-parent-display-name=Alice;reply-parent-msg-body=hello\\sthere;reply-parent-msg-id=m1;reply-parent-user-id=u1;reply-thread-parent-msg-id=t1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :reply text'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.replyTo).toEqual({
    user: 'Alice',
    text: 'hello there',
    id: 'm1',
    userId: 'u1',
    threadId: 't1',
  })
})

test('parseIrcLine: reply body containing % is preserved, not URI-decoded or dropped', () => {
  // Regression: decodeURIComponent threw URIError on bare '%' (dropping the
  // whole message) and silently decoded '%20' to a space. Tag values are
  // IRCv3 backslash-escaped, never percent-encoded.
  const raw =
    '@display-name=Bob;reply-parent-display-name=Alice;reply-parent-msg-body=im\\s100%\\ssure\\s%20\\sok;reply-parent-msg-id=m1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :agreed'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg).not.toBeNull()
  expect(msg.replyTo.text).toBe('im 100% sure %20 ok')
})

test('parseIrcLine: reply body unescapes \\: \\\\ \\r \\n per IRCv3', () => {
  const raw =
    '@display-name=Bob;reply-parent-display-name=Alice;reply-parent-msg-body=a\\:b\\\\c\\rd\\ne :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :reply'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.replyTo.text).toBe('a;b\\c\rd\ne')
})

test('parseIrcLine: no reply tags → replyTo is null', () => {
  const raw = '@display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :plain text'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.replyTo).toBeNull()
})

test('parseIrcLine: bits tag > 0 sets msg.bits', () => {
  const raw = '@display-name=Bob;bits=100 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :cheer100 nice'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.bits).toBe(100)
})

test('parseIrcLine: bits=0 or missing does not set msg.bits', () => {
  const raw1 = '@display-name=Bob;bits=0 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi'
  expect(parseIrcLine(raw1, 'chan').bits).toBeUndefined()
  const raw2 = '@display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi'
  expect(parseIrcLine(raw2, 'chan').bits).toBeUndefined()
})

test('parseIrcLine: custom-reward-id sets redeemed + rewardId', () => {
  const raw = '@display-name=Bob;custom-reward-id=reward-1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :redeemed msg'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.redeemed).toBe(true)
  expect(msg.rewardId).toBe('reward-1')
})

test('parseIrcLine: highlighted-message msg-id sets isHighlighted', () => {
  const raw = '@display-name=Bob;msg-id=highlighted-message :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.isHighlighted).toBe(true)
})

test('parseIrcLine: first-msg=1 sets isFirstMsg, returning-chatter=1 sets isReturningChatter', () => {
  const raw = '@display-name=Bob;first-msg=1;returning-chatter=1 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.isFirstMsg).toBe(true)
  expect(msg.isReturningChatter).toBe(true)
})

test('parseIrcLine: badge-info subscriber/N sets subMonths', () => {
  const raw = '@display-name=Bob;badge-info=subscriber/14 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.subMonths).toBe(14)
})

test('parseIrcLine: twitchEmotes tag attaches parsed emote map', () => {
  const raw = '@display-name=Bob;emotes=25:0-4 :bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :Kappa test'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.twitchEmotes).toEqual({ Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' })
})

test('parseIrcLine: channel falls back to the PRIVMSG target when none passed', () => {
  const raw = '@display-name=Bob :bob!bob@bob.tmi.twitch.tv PRIVMSG #SomeChannel :hi'
  const msg = parseIrcLine(raw, null)
  expect(msg.channel).toBe('somechannel')
})

test('parseIrcLine: no leading @tags returns null', () => {
  expect(parseIrcLine(':bob!bob@bob.tmi.twitch.tv PRIVMSG #chan :hi', 'chan')).toBeNull()
})

test('parseIrcLine: garbage input returns null, never throws', () => {
  expect(parseIrcLine('@ this is not irc at all', 'chan')).toBeNull()
  expect(parseIrcLine('', 'chan')).toBeNull()
  expect(() => parseIrcLine(undefined, 'chan')).not.toThrow()
  expect(parseIrcLine(undefined, 'chan')).toBeNull()
})

// ── parseIrcLine: raid window / isRaider ──────────────────────────────────

test('parseIrcLine: raid USERNOTICE opens a raid window, then first-msg PRIVMSG in-window is flagged isRaider', () => {
  const ch = `raidtest-${Date.now()}`
  const now = Date.now()
  const raidRaw = `@display-name=Raider;msg-id=raid;msg-param-viewerCount=50;msg-param-displayName=Raider;tmi-sent-ts=${now} :tmi.twitch.tv USERNOTICE #${ch} :raiding!`
  const raidMsg = parseIrcLine(raidRaw, ch)
  expect(raidMsg.msgId).toBe('raid')
  expect(raidMsg.raidViewers).toBe(50)
  expect(raidMsg.raidFrom).toBe('Raider')

  const privRaw = `@display-name=NewViewer;first-msg=1;tmi-sent-ts=${now + 1000} :newviewer!newviewer@newviewer.tmi.twitch.tv PRIVMSG #${ch} :hi from the raid`
  const privMsg = parseIrcLine(privRaw, ch)
  expect(privMsg.isFirstMsg).toBe(true)
  expect(privMsg.isRaider).toBe(true)
})

test('parseIrcLine: first-msg PRIVMSG outside the raid window is not flagged isRaider', () => {
  const ch = `raidtest2-${Date.now()}`
  const now = Date.now()
  const raidRaw = `@msg-id=raid;msg-param-viewerCount=10;tmi-sent-ts=${now} :tmi.twitch.tv USERNOTICE #${ch} :raiding!`
  parseIrcLine(raidRaw, ch)

  // 200 seconds later — RAID_WINDOW_MS is 90s, so this is well outside the window.
  const privRaw = `@display-name=Late;first-msg=1;tmi-sent-ts=${now + 200000} :late!late@late.tmi.twitch.tv PRIVMSG #${ch} :hi`
  const privMsg = parseIrcLine(privRaw, ch)
  expect(privMsg.isRaider).toBeUndefined()
})

test('parseIrcLine: regular (non-first-msg) chatter during a raid window is not flagged', () => {
  const ch = `raidtest3-${Date.now()}`
  const now = Date.now()
  parseIrcLine(`@msg-id=raid;tmi-sent-ts=${now} :tmi.twitch.tv USERNOTICE #${ch} :raiding!`, ch)
  const privRaw = `@display-name=Regular;tmi-sent-ts=${now + 500} :regular!regular@regular.tmi.twitch.tv PRIVMSG #${ch} :hi`
  const privMsg = parseIrcLine(privRaw, ch)
  expect(privMsg.isRaider).toBeUndefined()
})

// ── parseIrcLine: USERNOTICE (sub/resub/gift/watchstreak) ─────────────────

test('parseIrcLine: USERNOTICE sub tier 2000 maps to tier "2"', () => {
  const raw =
    '@display-name=Bob;msg-param-sub-plan=2000;msg-param-cumulative-months=5 :tmi.twitch.tv USERNOTICE #chan :resub message'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.type).toBe('usernotice')
  expect(msg.subTier).toBe('2')
  expect(msg.subMonths).toBe(5)
  expect(msg.text).toBe('resub message')
})

test('parseIrcLine: USERNOTICE Prime sub-plan maps to tier "prime"', () => {
  const raw = '@msg-param-sub-plan=Prime :tmi.twitch.tv USERNOTICE #chan :prime sub'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.subTier).toBe('prime')
})

test('parseIrcLine: USERNOTICE with no message body → empty text', () => {
  const raw = '@msg-id=subgift;msg-param-recipient-display-name=Charlie :tmi.twitch.tv USERNOTICE #chan'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.text).toBe('')
  expect(msg.recipient).toBe('Charlie')
})

test('parseIrcLine: USERNOTICE mass gift sets giftCount', () => {
  const raw = '@msg-id=submysterygift;msg-param-mass-gift-count=5 :tmi.twitch.tv USERNOTICE #chan :gifting 5 subs'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.giftCount).toBe(5)
})

test('parseIrcLine: watchstreak viewermilestone promoted to msgId watchstreak', () => {
  const raw =
    '@msg-id=viewermilestone;msg-param-category=watch-streak;msg-param-value=10 :tmi.twitch.tv USERNOTICE #chan :10 stream watch streak!'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.msgId).toBe('watchstreak')
  expect(msg.streakCount).toBe(10)
})

test('parseIrcLine: viewermilestone with a DIFFERENT category is not promoted', () => {
  const raw =
    '@msg-id=viewermilestone;msg-param-category=some-other-thing;msg-param-value=10 :tmi.twitch.tv USERNOTICE #chan :milestone'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.msgId).toBe('viewermilestone')
  expect(msg.streakCount).toBe(0)
})

test('parseIrcLine: USERNOTICE system-msg unescapes \\s to spaces', () => {
  const raw = '@system-msg=Bob\\ssubscribed\\swith\\sPrime! :tmi.twitch.tv USERNOTICE #chan :thanks'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.systemMsg).toBe('Bob subscribed with Prime!')
})

// ── parseIrcLine: NOTICE ──────────────────────────────────────────────────

test('parseIrcLine: NOTICE basic shape + deterministic id when server omits one', () => {
  const raw =
    '@tmi-sent-ts=1700000000000;msg-id=msg_banned :tmi.twitch.tv NOTICE #chan :You are banned from this channel.'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.type).toBe('notice')
  expect(msg.noticeType).toBe('msg_banned')
  expect(msg.text).toBe('You are banned from this channel.')
  expect(msg.id).toBe('notice-chan-1700000000000-You are banned from this channel.')
})

test('parseIrcLine: NOTICE with explicit id tag uses that id', () => {
  const raw = '@id=abc :tmi.twitch.tv NOTICE #chan :some notice'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.id).toBe('abc')
})

// ── parseIrcLine: ROOMSTATE ────────────────────────────────────────────────

test('parseIrcLine: ROOMSTATE parses all mode flags', () => {
  const raw = '@slow=30;subs-only=1;emote-only=0;followers-only=10;r9k=1 :tmi.twitch.tv ROOMSTATE #chan'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.type).toBe('roomstate')
  expect(msg.slow).toBe(30)
  expect(msg.subsOnly).toBe(true)
  expect(msg.emoteOnly).toBe(false)
  expect(msg.followersOnly).toBe(10)
  expect(msg.r9k).toBe(true)
})

test('parseIrcLine: ROOMSTATE with only partial tags leaves others null (not false/0)', () => {
  const raw = '@slow=0 :tmi.twitch.tv ROOMSTATE #chan'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.slow).toBe(0)
  expect(msg.subsOnly).toBeNull()
  expect(msg.emoteOnly).toBeNull()
  expect(msg.followersOnly).toBeNull()
  expect(msg.r9k).toBeNull()
})

// ── parseIrcLine: USERSTATE ────────────────────────────────────────────────

test('parseIrcLine: USERSTATE collects badge names into a Set', () => {
  const raw = '@badges=subscriber/12,premium/1 :tmi.twitch.tv USERSTATE #chan'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.type).toBe('userstate')
  expect(msg.badges instanceof Set).toBe(true)
  expect(msg.badges.has('subscriber')).toBe(true)
  expect(msg.badges.has('premium')).toBe(true)
})

// ── parseIrcLine: CLEARCHAT ────────────────────────────────────────────────

test('parseIrcLine: CLEARCHAT with ban-duration → timeout notice', () => {
  const raw = '@ban-duration=600;target-user-id=42;tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #chan :baduser'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.noticeType).toBe('timeout_success')
  expect(msg.text).toBe('baduser timed out for 600s')
  expect(msg.targetUser).toBe('baduser')
  expect(msg.targetUserId).toBe('42')
  expect(msg.banDuration).toBe(600)
})

test('parseIrcLine: CLEARCHAT without ban-duration → permanent ban notice', () => {
  const raw = '@tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #chan :baduser'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.noticeType).toBe('ban_success')
  expect(msg.text).toBe('baduser was permanently banned')
  expect(msg.banDuration).toBe(0)
})

test('parseIrcLine: CLEARCHAT with no target (chat cleared entirely) uses t() fallback text', () => {
  const raw = '@tmi-sent-ts=1700000000000 :tmi.twitch.tv CLEARCHAT #chan'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.text).toBe('mc_irc_chat_cleared')
  expect(msg.targetUser).toBe('')
})

// ── parseIrcLine: CLEARMSG ─────────────────────────────────────────────────

test('parseIrcLine: CLEARMSG carries target-msg-id and login', () => {
  const raw = '@login=baduser;target-msg-id=msg-1 :tmi.twitch.tv CLEARMSG #chan :deleted text here'
  const msg = parseIrcLine(raw, 'chan')
  expect(msg.noticeType).toBe('delete_message_success')
  expect(msg.targetUser).toBe('baduser')
  expect(msg.targetMsgId).toBe('msg-1')
  expect(msg.id).toBe('msg-1')
})

// ── parseIrcLine: WHISPER ──────────────────────────────────────────────────

test('parseIrcLine: WHISPER basic shape', () => {
  const raw = '@display-name=Bob;user-id=7;message-id=w1 :bob!bob@bob.tmi.twitch.tv WHISPER me :psst'
  const msg = parseIrcLine(raw, null)
  expect(msg.type).toBe('whisper')
  expect(msg.user).toBe('Bob')
  expect(msg.text).toBe('psst')
  expect(msg.id).toBe('w1')
})

// ── CircularBuffer ──────────────────────────────────────────────────────────

test('CircularBuffer: push + getAll preserves insertion order under capacity', () => {
  const buf = new CircularBuffer(5)
  buf.push('a')
  buf.push('b')
  buf.push('c')
  expect(buf.getAll()).toEqual(['a', 'b', 'c'])
})

test('CircularBuffer: wraps and evicts oldest entries once at capacity', () => {
  const buf = new CircularBuffer(3)
  buf.push(1)
  buf.push(2)
  buf.push(3)
  buf.push(4) // evicts 1
  expect(buf.getAll()).toEqual([2, 3, 4])
})

test('CircularBuffer: heavy wraparound keeps correct chronological order', () => {
  const buf = new CircularBuffer(4)
  for (let i = 0; i < 10; i++) buf.push(i)
  expect(buf.getAll()).toEqual([6, 7, 8, 9])
})

test('CircularBuffer: clear() empties the buffer', () => {
  const buf = new CircularBuffer(3)
  buf.push('x')
  buf.push('y')
  buf.clear()
  expect(buf.getAll()).toEqual([])
})

test('CircularBuffer: default capacity is 1500', () => {
  const buf = new CircularBuffer()
  expect(buf.cap).toBe(1500)
})

test('CircularBuffer: getAll on empty buffer returns []', () => {
  expect(new CircularBuffer(10).getAll()).toEqual([])
})

test('parseIrcLine: colon-less single-word PRIVMSG (robotty history form) parses', () => {
  const msg = parseIrcLine(
    '@display-name=Dongblob;user-id=371;id=abc;tmi-sent-ts=1786370000000 :dongblob!dongblob@dongblob.tmi.twitch.tv PRIVMSG #nl_kripp ELKEKO',
    'nl_kripp',
  )
  expect(msg?.text).toBe('ELKEKO')
  expect(msg?.login).toBe('dongblob')
})

test('parseIrcLine: colon form with spaces still parses intact', () => {
  const msg = parseIrcLine(
    '@display-name=Alice;id=d1 :alice!alice@alice.tmi.twitch.tv PRIVMSG #ch :two words here',
    'ch',
  )
  expect(msg?.text).toBe('two words here')
})
