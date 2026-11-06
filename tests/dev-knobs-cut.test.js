import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { coerceSettingValue, SETTINGS, userSubsystemGates } from '../src/lib/settings-schema.js'
import { RETIRED_UI_KEYS } from '../src/lib/utils.js'

// Developer and tuning knobs left the settings page: each one's value is now
// the default it already had for nearly everyone, and nothing reads the key.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const CUT_SYNC = [
  'debugLogging',
  'crashTelemetry',
  'emoteProviderPriority',
  'partialLinksEnabled',
  'channelVolumeTwitch',
  'channelVolumeKick',
  'channelVolumeYouTube',
  'crossFollowTwitchNotify',
  'ytFeedShelves',
  'nativeVisible',
]

test('the knobs are gone from the registry and retired', () => {
  for (const k of [...CUT_SYNC, 'hs_dom_render_cap']) expect(SETTINGS.some((d) => d.key === k)).toBe(false)
  for (const k of CUT_SYNC) expect(RETIRED_UI_KEYS.has(k)).toBe(true)
})

test('subsystems keeps only the per-site overlay switches', () => {
  const def = SETTINGS.find((d) => d.key === 'subsystems')
  expect(def.options.map((o) => o.value)).toEqual(['overlay-twitch', 'overlay-kick', 'overlay-youtube'])
  expect(coerceSettingValue(def, { feed: false, 'overlay-kick': false })).toEqual({
    'overlay-twitch': true,
    'overlay-kick': false,
    'overlay-youtube': true,
  })
})

test('a stored feature switch no longer gates anything at boot', () => {
  expect(userSubsystemGates({ feed: false, cosmetics: false, 'overlay-twitch': false })).toEqual({
    'overlay-twitch': false,
    'overlay-kick': true,
    'overlay-youtube': true,
  })
  expect(userSubsystemGates(null)).toEqual({ 'overlay-twitch': true, 'overlay-kick': true, 'overlay-youtube': true })
  expect(read('src/multichat/main.js')).toContain('_gatesAtBoot = userSubsystemGates(stored)')
})

test('nothing reads the cut keys', () => {
  const checks = {
    'chrome/content.js': ['debugLogging', 'subsystems?.cosmetics'],
    'chrome/player-volume.js': ['channelVolumeTwitch', 'channelVolumeKick', 'channelVolumeYouTube'],
    'src/multichat/cross-follow.js': ['crossFollowTwitchNotify'],
    'src/multichat/settings-ui.js': ['crashTelemetry', '_loadCrashLog'],
    'src/multichat/main.js': [
      'ytFeedShelves',
      'nativeVisible',
      'partialLinksEnabled',
      'domRenderCap:',
      'hs_dom_render_cap',
      'renderCap:',
    ],
    'src/multichat/social.js': ['partialLinksEnabled'],
    'src/multichat/chat-logs.js': ['partialLinksEnabled'],
    'src/multichat/chat-position.js': ['nativeVisible'],
    'src/multichat/resize.js': ['nativeVisible'],
    'src/multichat/twitch-host.js': ['nativeVisible'],
    'src/multichat/kick-host.js': ['nativeVisible'],
  }
  for (const [file, words] of Object.entries(checks)) {
    const src = read(file)
    for (const w of words) expect(src.includes(w), `${file} still reads ${w}`).toBe(false)
  }
})
