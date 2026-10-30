import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * resolveSendTargets / nextSendTargets (src/multichat/send-targets.js).
 *
 * The file has no import/export — it's concatenated into the multichat
 * bundle (see build.js MULTICHAT_MODULES) as plain global function
 * declarations, same rationale as sent-echo.test.js / tab-complete-order.test.js.
 * Loaded here via new Function so the test exercises the real source.
 *
 * youtubeSendErrorMessage calls the bundle-global `t()` (src/lib/browser-api.js
 * in the real bundle) — stub it on globalThis before each test, resolving
 * against the real en/messages.json so this also proves the i18n keys exist
 * and match copy (matches the pattern in irc-parser.test.js).
 */
function loadSendTargets() {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'send-targets.js'), 'utf8')
  const fn = new Function(
    `${src}; return { resolveSendTargets, nextSendTargets, extractYoutubeVideoId, youtubeSendErrorMessage, ytReplyText, composerCharLimit }`,
  )
  return fn()
}

const {
  resolveSendTargets,
  nextSendTargets,
  extractYoutubeVideoId,
  youtubeSendErrorMessage,
  ytReplyText,
  composerCharLimit,
} = loadSendTargets()

const enMessages = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8'),
)
beforeEach(() => {
  globalThis.t = (key) => enMessages[key]?.message ?? key
  // ytReplyText calls the bundle-global log() on the length-cap skip path.
  globalThis.log = () => {}
})
afterEach(() => {
  globalThis.t = undefined
  globalThis.log = undefined
})

test('resolveSendTargets defaults every linked platform on when absent', () => {
  expect(resolveSendTargets(undefined, { twitch: true, kick: true, youtube: false })).toEqual({
    twitch: true,
    kick: true,
    youtube: false,
  })
})

test('resolveSendTargets defaults every linked platform on when null', () => {
  expect(resolveSendTargets(null, { twitch: true, kick: false, youtube: true })).toEqual({
    twitch: true,
    kick: false,
    youtube: true,
  })
})

test('resolveSendTargets respects an explicit false on a linked platform', () => {
  expect(resolveSendTargets({ kick: false }, { twitch: true, kick: true, youtube: false })).toEqual({
    twitch: true,
    kick: false,
    youtube: false,
  })
})

test('resolveSendTargets cannot enable a platform that is not linked', () => {
  expect(resolveSendTargets({ youtube: true }, { twitch: true, kick: false, youtube: false })).toEqual({
    twitch: true,
    kick: false,
    youtube: false,
  })
})

test('resolveSendTargets falls back to all-linked-on if resolution would disable every target', () => {
  expect(resolveSendTargets({ twitch: false, kick: false }, { twitch: true, kick: true, youtube: false })).toEqual({
    twitch: true,
    kick: true,
    youtube: false,
  })
})

test('nextSendTargets seeds from linked platforms on first toggle', () => {
  expect(nextSendTargets(undefined, { twitch: true, kick: true, youtube: false }, 'twitch', false)).toEqual({
    twitch: false,
    kick: true,
  })
})

test('nextSendTargets refuses to disable the last active linked target', () => {
  expect(
    nextSendTargets({ twitch: false, kick: true }, { twitch: true, kick: true, youtube: false }, 'kick', false),
  ).toBeNull()
})

test('nextSendTargets ignores a toggle on a platform that is not linked', () => {
  expect(nextSendTargets({ twitch: true }, { twitch: true, kick: false, youtube: false }, 'kick', true)).toEqual({
    twitch: true,
  })
})

test('nextSendTargets allows re-enabling a previously disabled platform', () => {
  expect(
    nextSendTargets({ twitch: false, kick: true }, { twitch: true, kick: true, youtube: false }, 'twitch', true),
  ).toEqual({
    twitch: true,
    kick: true,
  })
})

// ─── extractYoutubeVideoId ────────────────────────────────────────────────────
// Only a CONCRETE 11-char video id may come back — a channel-only url must
// yield '' so background never auto-opens (and sends to) the wrong stream.

test('extractYoutubeVideoId pulls id from watch?v= url', () => {
  expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
})

test('extractYoutubeVideoId pulls id from watch url with extra params', () => {
  expect(extractYoutubeVideoId('https://www.youtube.com/watch?list=RD&v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ')
})

test('extractYoutubeVideoId handles /live/<id>, youtu.be, /shorts/, /embed/', () => {
  expect(extractYoutubeVideoId('https://www.youtube.com/live/abcdefghijk')).toBe('abcdefghijk')
  expect(extractYoutubeVideoId('https://youtu.be/abcdefghijk')).toBe('abcdefghijk')
  expect(extractYoutubeVideoId('https://www.youtube.com/shorts/abcdefghijk')).toBe('abcdefghijk')
  expect(extractYoutubeVideoId('https://www.youtube.com/embed/abcdefghijk')).toBe('abcdefghijk')
})

test('extractYoutubeVideoId returns "" for channel-only urls (no fixed stream)', () => {
  expect(extractYoutubeVideoId('https://www.youtube.com/@somehandle')).toBe('')
  expect(extractYoutubeVideoId('https://www.youtube.com/@somehandle/live')).toBe('')
  expect(extractYoutubeVideoId('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv')).toBe('')
  expect(extractYoutubeVideoId('')).toBe('')
  expect(extractYoutubeVideoId(null)).toBe('')
  expect(extractYoutubeVideoId(undefined)).toBe('')
})

test('extractYoutubeVideoId rejects too-short / too-long ids at the boundary', () => {
  expect(extractYoutubeVideoId('https://www.youtube.com/watch?v=tooshort')).toBe('')
  // 12+ id chars: the strict-boundary regex refuses a partial match
  expect(extractYoutubeVideoId('https://www.youtube.com/live/abcdefghijklmnop')).toBe('')
})

// ─── youtubeSendErrorMessage ──────────────────────────────────────────────────

test('youtubeSendErrorMessage maps known codes to actionable lines', () => {
  expect(youtubeSendErrorMessage('no_youtube_tab')).toBe('open the youtube stream to send')
  expect(youtubeSendErrorMessage('no_video')).toBe('open the youtube stream to send')
  expect(youtubeSendErrorMessage('chat_disabled')).toBe('log into youtube to send')
  expect(youtubeSendErrorMessage('no_input')).toBe('youtube chat still loading — try again')
  expect(youtubeSendErrorMessage('bridge_timeout')).toBe('couldn’t reach youtube chat — try again')
})

test('youtubeSendErrorMessage falls back for unknown/undefined codes', () => {
  expect(youtubeSendErrorMessage('send_failed')).toBe('youtube send failed')
  expect(youtubeSendErrorMessage(undefined)).toBe('youtube send failed')
})

// ─── ytReplyText ──────────────────────────────────────────────────────────────
// YouTube live chat has no reply-threading API — a reply's context only
// survives on the YT leg via a prepended "@author " mention.

test('ytReplyText prepends the reply author', () => {
  expect(ytReplyText('gg well played', 'coaoaba')).toBe('@coaoaba gg well played')
})

test("ytReplyText strips the author's own @ before prepending (yt handles carry it)", () => {
  expect(ytReplyText('gg well played', '@coaoaba')).toBe('@coaoaba gg well played')
})

test('ytReplyText @-author does not double when user already typed the mention', () => {
  expect(ytReplyText('@coaoaba gg', '@coaoaba')).toBe('@coaoaba gg')
})

test('ytReplyText passes text through untouched when there is no reply author', () => {
  expect(ytReplyText('just chatting', null)).toBe('just chatting')
  expect(ytReplyText('just chatting', undefined)).toBe('just chatting')
  expect(ytReplyText('just chatting', '')).toBe('just chatting')
})

test('ytReplyText does not double-prepend when the user already typed the mention', () => {
  expect(ytReplyText('@coaoaba gg well played', 'coaoaba')).toBe('@coaoaba gg well played')
})

test('ytReplyText mention match is case-insensitive', () => {
  expect(ytReplyText('@CoAoAba gg well played', 'coaoaba')).toBe('@CoAoAba gg well played')
  expect(ytReplyText('@coaoaba gg well played', 'CoAoAba')).toBe('@coaoaba gg well played')
})

test('ytReplyText treats a bare "@author" with no trailing text as already-mentioned', () => {
  expect(ytReplyText('@coaoaba', 'coaoaba')).toBe('@coaoaba')
})

test('ytReplyText does not treat "@authorxyz" as already mentioning "author"', () => {
  expect(ytReplyText('@coaoabaXYZ gg', 'coaoaba')).toBe('@coaoaba @coaoabaXYZ gg')
})

test('ytReplyText skips the prepend (never truncates) when it would exceed the 200-char cap', () => {
  const longAuthor = 'a'.repeat(50)
  const body = 'b'.repeat(190) // + "@<50 a's> " prefix pushes well past 200
  expect(ytReplyText(body, longAuthor)).toBe(body)
})

test('ytReplyText prepends right up to the 200-char boundary', () => {
  const author = 'ab' // "@ab " = 4 chars
  const body = 'c'.repeat(196) // 4 + 196 = 200, exactly at the cap
  expect(ytReplyText(body, author)).toBe(`@${author} ${body}`)
  expect(ytReplyText(body, author).length).toBe(200)
})

test('ytReplyText treats a whitespace-only author as absent', () => {
  expect(ytReplyText('hey', '   ')).toBe('hey')
})

test('ytReplyText escapes regex-special characters in the author name', () => {
  expect(ytReplyText('hi there', 'a.b+c')).toBe('@a.b+c hi there')
  // Already-mentioned check must not let "." match any char
  expect(ytReplyText('@aXb+c hi there', 'a.b+c')).toBe('@a.b+c @aXb+c hi there')
})

test('composerCharLimit: youtube leg caps at 200, twitch/kick and unknown stay 500', () => {
  expect(composerCharLimit({ youtube: true })).toBe(200)
  expect(composerCharLimit({ twitch: true, youtube: true })).toBe(200)
  expect(composerCharLimit({ twitch: true, kick: true })).toBe(500)
  expect(composerCharLimit(null)).toBe(500)
})
