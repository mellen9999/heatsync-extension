import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { lintSettings, SETTINGS, settingShowsOnHost } from '../src/lib/settings-schema.js'

// A row shows only on the sites it affects. youtube-only layout switches on
// twitch and kick, and an anonymous-presence switch that only twitch's gql
// honours, were rows that did nothing where they were shown.
const def = (k) => SETTINGS.find((d) => d.key === k)

test('youtube-only rows show on youtube alone', () => {
  for (const k of ['ytShowSuggestions', 'ytChatOnNonLive']) {
    expect(settingShowsOnHost(def(k), 'yt')).toBe(true)
    expect(settingShowsOnHost(def(k), 'twitch')).toBe(false)
    expect(settingShowsOnHost(def(k), 'kick')).toBe(false)
  }
})

test('anonymous presence shows on twitch alone, under a twitch label', () => {
  const d = def('anonChat')
  expect(settingShowsOnHost(d, 'twitch')).toBe(true)
  expect(settingShowsOnHost(d, 'kick')).toBe(false)
  expect(settingShowsOnHost(d, 'yt')).toBe(false)
  const en = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'))
  expect(en[d.labelKey].message).toContain('twitch')
})

test('a row without hosts shows everywhere, and an unknown host hides nothing', () => {
  expect(settingShowsOnHost(def('zebra'), 'kick')).toBe(true)
  expect(settingShowsOnHost(def('ytShowSuggestions'), undefined)).toBe(true)
})

test('lint rejects a host that is not a site', () => {
  const d = def('zebra')
  d.hosts = ['myspace']
  try {
    expect(lintSettings(null)).toContain('bad hosts: zebra')
  } finally {
    delete d.hosts
  }
})

test('the settings page filters every row list through the host check', () => {
  const src = readFileSync(new URL('../src/multichat/settings-ui.js', import.meta.url), 'utf8')
  expect(src).toContain('settingShowsOnHost(def, typeof hostPlatform')
  expect(src).not.toMatch(/\|\| !_depSatisfied\(def\)\)|if \(!_depSatisfied\(def\)\) continue/)
})
