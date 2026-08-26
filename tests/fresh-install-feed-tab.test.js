/**
 * The feed tab must be on the bar for a signed-out fresh install.
 *
 * `feed` sat in DEFAULT_HIDDEN_TABS from 2026-07-27, which was correct then —
 * the feed was an empty wall for a signed-out user. The 2026-08-16 cold-start
 * fix ended that (/api/messages/hot serves 30 real rows anonymously and
 * social.js dropped its auth gate), but this list was never revisited, so a
 * brand-new install still had no feed tab until it logged in. That is why prod
 * measured ~5 live installs a day and zero requests to the feed endpoint.
 *
 * These pin the three things that keep it fixed: feed is off the fresh-install
 * list, installs already stamped with the old list get it back exactly once,
 * and a deliberate choice to hide it is never overridden.
 *
 * The functions are closure-local inside main.js's IIFE and can't be imported,
 * so their real source is evaluated against stubs — behavioral, not a grep.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')

function sliceBetween(marker, endMarker) {
  const start = MAIN_SRC.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker} — main.js drifted`)
  const end = MAIN_SRC.indexOf(endMarker, start)
  if (end === -1) throw new Error(`end marker not found: ${endMarker} — main.js drifted`)
  return MAIN_SRC.slice(start, end)
}

const TABS_SRC = sliceBetween('  const HIDABLE_TABS = ', '  // Timestamps on messages')

function makeHarness({ hiddenTabs, local = {}, sync = {}, hydrated = true } = {}) {
  const settings = { hiddenTabs }
  const localStore = { ...local }
  const chrome = {
    storage: {
      local: {
        get: async (k) => (k in localStore ? { [k]: localStore[k] } : {}),
        set: async (obj) => Object.assign(localStore, obj),
        remove: async (k) => {
          delete localStore[k]
          return undefined
        },
      },
      sync: { get: async (k) => ({ [k]: sync[k] }) },
    },
  }
  // storage.local.remove is called with .catch() attached in the source
  chrome.storage.local.remove = (k) => {
    delete localStore[k]
    return Promise.resolve()
  }
  chrome.storage.local.set = (obj) => {
    Object.assign(localStore, obj)
    return Promise.resolve()
  }
  const api = new Function(
    'chrome',
    'getSetting',
    'setSetting',
    'saveUiSetting',
    '_settingsHydrated',
    `${TABS_SRC}\nreturn { DEFAULT_HIDDEN_TABS, LEGACY_FRESH_HIDDEN_TABS, applyFreshInstallHiddenTabs, revealFreshInstallTabsOnce, unhideFeedOnce }`,
  )(
    chrome,
    (k) => settings[k],
    (k, v) => {
      settings[k] = v
    },
    (k, v) => {
      settings[k] = v
    },
    hydrated,
  )
  return { ...api, settings, localStore }
}

const LEGACY = ['pinned', 'feed', 'whispers', 'mentions', 'modlog']

describe('fresh-install hidden tabs', () => {
  test('feed is NOT hidden on a fresh install', () => {
    const h = makeHarness({ hiddenTabs: ['pinned'] })
    expect(h.DEFAULT_HIDDEN_TABS).not.toContain('feed')
  })

  test('the genuinely login-walled tabs stay hidden', () => {
    const h = makeHarness({ hiddenTabs: ['pinned'] })
    for (const id of ['whispers', 'mentions', 'modlog', 'pinned']) {
      expect(h.DEFAULT_HIDDEN_TABS).toContain(id)
    }
  })

  test('a fresh install is stamped without feed', async () => {
    const h = makeHarness({
      hiddenTabs: ['pinned'],
      local: { hs_fresh_install_hidden_tabs: true },
    })
    await h.applyFreshInstallHiddenTabs()
    expect(h.settings.hiddenTabs).not.toContain('feed')
    expect(h.settings.hiddenTabs).toContain('whispers')
  })
})

describe('unhideFeedOnce', () => {
  test('gives feed back to an install carrying the legacy set', async () => {
    const h = makeHarness({ hiddenTabs: [...LEGACY] })
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).not.toContain('feed')
    // the rest are untouched — they really are login-walled
    expect(h.settings.hiddenTabs).toContain('whispers')
    expect(h.settings.hiddenTabs).toContain('mentions')
    expect(h.settings.hiddenTabs).toContain('modlog')
  })

  test('runs exactly once', async () => {
    const h = makeHarness({ hiddenTabs: [...LEGACY] })
    await h.unhideFeedOnce()
    h.settings.hiddenTabs = [...LEGACY] // user re-hides feed deliberately
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).toContain('feed')
  })

  // Any manual edit leaves a set that is not an exact legacy match, so a
  // deliberate choice can never be overridden.
  test('leaves a customised set alone', async () => {
    const h = makeHarness({ hiddenTabs: ['feed', 'pinned'] })
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).toEqual(['feed', 'pinned'])
  })

  test('does nothing for an install that never had the legacy set', async () => {
    const h = makeHarness({ hiddenTabs: ['pinned'] })
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).toEqual(['pinned'])
  })
})

describe('revealFreshInstallTabsOnce', () => {
  test('still reveals an install stamped with the legacy set', async () => {
    const h = makeHarness({
      hiddenTabs: [...LEGACY],
      sync: { ui_settings: { hiddenTabsRevealPending: true } },
    })
    await h.revealFreshInstallTabsOnce()
    expect(h.settings.hiddenTabs).toEqual(['pinned'])
  })

  test('reveals an install stamped with the current set', async () => {
    const h = makeHarness({
      hiddenTabs: ['pinned', 'whispers', 'mentions', 'modlog'],
      sync: { ui_settings: { hiddenTabsRevealPending: true } },
    })
    await h.revealFreshInstallTabsOnce()
    expect(h.settings.hiddenTabs).toEqual(['pinned'])
  })

  test('leaves a customised set alone', async () => {
    const h = makeHarness({
      hiddenTabs: ['modlog'],
      sync: { ui_settings: { hiddenTabsRevealPending: true } },
    })
    await h.revealFreshInstallTabsOnce()
    expect(h.settings.hiddenTabs).toEqual(['modlog'])
  })
})

// The fifth layer. Boot wraps loadAllSettings() in Promise.race(..., 5s); a slow
// chrome.storage.sync loses that race and init continues with an EMPTY settings
// cache, so getSetting('hiddenTabs') returns the ['pinned'] registry default
// rather than whatever the install actually has. Both one-shots used to consume
// their guard BEFORE reading, so an install that hit the slow path was left
// with no feed tab and no way to ever get one — permanently stranded by the very
// migration written to rescue it. These pin the retry.
describe('one-shots vs an unhydrated settings cache', () => {
  test('unhideFeedOnce does not burn its guard when settings never loaded', async () => {
    const h = makeHarness({ hiddenTabs: ['pinned'], hydrated: false })
    await h.unhideFeedOnce()
    expect(h.localStore.hs_feed_unhidden_v2).toBeUndefined()
  })

  test('the retry actually restores feed on the next boot', async () => {
    const stranded = makeHarness({ hiddenTabs: ['pinned'], hydrated: false })
    await stranded.unhideFeedOnce()
    // next boot, settings hydrate and the real legacy set is visible
    const h = makeHarness({ hiddenTabs: [...LEGACY], local: stranded.localStore })
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).not.toContain('feed')
    expect(h.localStore.hs_feed_unhidden_v2).toBe(true)
  })

  test('applyFreshInstallHiddenTabs keeps its flag when settings never loaded', async () => {
    const h = makeHarness({
      hiddenTabs: ['pinned'],
      local: { hs_fresh_install_hidden_tabs: true },
      hydrated: false,
    })
    await h.applyFreshInstallHiddenTabs()
    expect(h.localStore.hs_fresh_install_hidden_tabs).toBe(true)
    expect(h.settings.hiddenTabs).toEqual(['pinned'])
  })
})

// The repair pass. 1.7.65/66 shipped the guard-before-read bug, so by the time
// the fix reaches anyone every existing install has ALREADY run it — and the
// ones it stranded carry a burned v1 flag plus an untouched legacy set. Gating
// on hydration alone would leave exactly those users, the only users there are,
// broken forever. v2 is what actually rescues them.
describe('v2 repair of installs stranded by the 1.7.66 bug', () => {
  test('rescues an install the v1 one-shot burned without fixing', async () => {
    const h = makeHarness({
      hiddenTabs: [...LEGACY],
      local: { hs_feed_unhidden: true }, // v1 flag burned, feed never restored
    })
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).not.toContain('feed')
    expect(h.localStore.hs_feed_unhidden_v2).toBe(true)
  })

  test('is a no-op for an install v1 migrated correctly', async () => {
    const h = makeHarness({
      hiddenTabs: ['pinned', 'whispers', 'mentions', 'modlog'],
      local: { hs_feed_unhidden: true },
    })
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).toEqual(['pinned', 'whispers', 'mentions', 'modlog'])
  })

  test('does not re-fire once v2 has run', async () => {
    const h = makeHarness({ hiddenTabs: [...LEGACY], local: { hs_feed_unhidden_v2: true } })
    await h.unhideFeedOnce()
    expect(h.settings.hiddenTabs).toContain('feed')
  })
})
