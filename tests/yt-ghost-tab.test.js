import { expect, test } from 'bun:test'
import { identityYtLiveUrl, isValidTwitchLogin, resolveYtLiveLabel } from '../src/lib/utils.js'

// ── isValidTwitchLogin ────────────────────────────────────────────────────────
// reconcileAutoTabs gate: BG's open-channel set is twitch IRC interest —
// yt videoIds that leaked in pre-fix must never become ephemeral tabs.

test('isValidTwitchLogin: real twitch logins pass', () => {
  expect(isValidTwitchLogin('nl_kripp')).toBe(true)
  expect(isValidTwitchLogin('zackrawrr')).toBe(true)
  expect(isValidTwitchLogin('a')).toBe(true)
  expect(isValidTwitchLogin('x'.repeat(25))).toBe(true)
})

test('isValidTwitchLogin: hyphenated yt videoIds are rejected', () => {
  // videoIds may carry '-' — never valid in a twitch login
  expect(isValidTwitchLogin('dqw4w9wgxcq')).toBe(true) // hyphen-free id passes (indistinguishable — upstream join fix owns this case)
  expect(isValidTwitchLogin('abc-def_123')).toBe(false)
  expect(isValidTwitchLogin('-jfkfpfyjrd')).toBe(false)
})

test('isValidTwitchLogin: junk is rejected', () => {
  expect(isValidTwitchLogin('')).toBe(false)
  expect(isValidTwitchLogin(null)).toBe(false)
  expect(isValidTwitchLogin(undefined)).toBe(false)
  expect(isValidTwitchLogin('JfKfPfyJRdk')).toBe(false) // openSet is lowercased; raw mixed case never valid
  expect(isValidTwitchLogin('x'.repeat(26))).toBe(false)
  expect(isValidTwitchLogin('has space')).toBe(false)
})

// ── resolveYtLiveLabel ────────────────────────────────────────────────────────
// Live-tab composer label on yt pages: raw videoId → resolved channel name,
// or '' (generic prompt) while unresolved / dead stream.

test('resolveYtLiveLabel: videoId swaps to resolved channel name', () => {
  expect(
    resolveYtLiveLabel('jfKfPfyJRdk', {
      isYtVideoPage: true,
      autoVideoId: 'jfKfPfyJRdk',
      resolvedName: 'Lofi Girl',
    }),
  ).toBe('Lofi Girl')
})

test('resolveYtLiveLabel: a premiere never gets a status echo, so the uploader on the page names it', () => {
  expect(
    resolveYtLiveLabel('zpBEomubNSs', {
      isYtVideoPage: true,
      autoVideoId: 'zpBEomubNSs',
      resolvedName: '',
      pageName: 'Control Players Unite',
    }),
  ).toBe('Control Players Unite')
  // the server's own name still wins when it is there
  expect(
    resolveYtLiveLabel('zpBEomubNSs', { isYtVideoPage: true, autoVideoId: null, resolvedName: 'CPU', pageName: 'x' }),
  ).toBe('CPU')
})

test('resolveYtLiveLabel: unresolved videoId yields empty (generic prompt), never the raw id', () => {
  expect(resolveYtLiveLabel('jfKfPfyJRdk', { isYtVideoPage: true, autoVideoId: 'jfKfPfyJRdk', resolvedName: '' })).toBe(
    '',
  )
  // dead/unplayable stream: no _autoYtVideoId gate, but still a /watch page
  expect(resolveYtLiveLabel('jfKfPfyJRdk', { isYtVideoPage: true, autoVideoId: null, resolvedName: '' })).toBe('')
})

test('resolveYtLiveLabel: named channels pass through untouched', () => {
  // @handle page — handle, not a videoId shape
  expect(resolveYtLiveLabel('lofigirl', { isYtVideoPage: false, autoVideoId: null, resolvedName: '' })).toBe('lofigirl')
  // explicit live override that happens to be long
  expect(
    resolveYtLiveLabel('some_channel_name', { isYtVideoPage: true, autoVideoId: 'jfKfPfyJRdk', resolvedName: 'x' }),
  ).toBe('some_channel_name')
})

test('resolveYtLiveLabel: 11-char name off a video page is left alone', () => {
  // not on /watch|/live/ and not the auto videoId → treat as a real name
  expect(resolveYtLiveLabel('elevenchars', { isYtVideoPage: false, autoVideoId: null, resolvedName: '' })).toBe(
    'elevenchars',
  )
})

test('resolveYtLiveLabel: empty/null channel yields empty string', () => {
  expect(resolveYtLiveLabel(null, { isYtVideoPage: true, autoVideoId: null, resolvedName: 'x' })).toBe('')
  expect(resolveYtLiveLabel('', { isYtVideoPage: false, autoVideoId: null, resolvedName: '' })).toBe('')
})

// ── identityYtLiveUrl ─────────────────────────────────────────────────────────
// config.channels youtube slots hold full URLs, never bare handles/ids —
// pcAddAsChannel used to store identity.youtube raw, breaking ws-subscribe.

test('identityYtLiveUrl: profile @handle wins, @ stripped once', () => {
  expect(identityYtLiveUrl({ profile: { youtube_username: '@Kripparrian' } })).toBe(
    'https://www.youtube.com/@Kripparrian/live',
  )
  expect(identityYtLiveUrl({ profile: { youtube_username: 'Kripparrian' } })).toBe(
    'https://www.youtube.com/@Kripparrian/live',
  )
})

test('identityYtLiveUrl: profile channel id when no handle (hyphens survive)', () => {
  expect(identityYtLiveUrl({ profile: { youtube_channel_id: 'UCC-uu-OXVVAasgmBLKKGnOg' } })).toBe(
    'https://www.youtube.com/channel/UCC-uu-OXVVAasgmBLKKGnOg/live',
  )
})

test('identityYtLiveUrl: identity.youtube fallback disambiguates UC id vs handle', () => {
  expect(identityYtLiveUrl({ identity: { youtube: 'UCC-uu-OXVVAasgmBLKKGnOg' } })).toBe(
    'https://www.youtube.com/channel/UCC-uu-OXVVAasgmBLKKGnOg/live',
  )
  expect(identityYtLiveUrl({ identity: { youtube: 'kripparrian' } })).toBe('https://www.youtube.com/@kripparrian/live')
})

test('identityYtLiveUrl: no linkage yields empty string, never a guessed URL', () => {
  expect(identityYtLiveUrl(null)).toBe('')
  expect(identityYtLiveUrl({})).toBe('')
  expect(identityYtLiveUrl({ identity: { twitch: 'nl_kripp' }, profile: {} })).toBe('')
})
