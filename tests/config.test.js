/**
 * Unit tests for src/lib/config.js
 *
 * Tests STRUCTURAL INVARIANTS — things that catch regressions if someone
 * accidentally deletes a key, changes a type, or sets a nonsensical value.
 * Does NOT pin every literal (those churn); DOES pin critical constants
 * (e.g. API_URL must be the heatsync origin, emote size limits must be sane).
 */

import { describe, expect, test } from 'bun:test'
import CONFIG, { CONFIG as namedConfig } from '../src/lib/config.js'

// ── export shape ─────────────────────────────────────────────────────────────

describe('config: exports', () => {
  test('default export is an object', () => {
    expect(typeof CONFIG).toBe('object')
    expect(CONFIG).not.toBeNull()
  })

  test('named export CONFIG equals default export', () => {
    expect(namedConfig).toBe(CONFIG)
  })
})

// ── top-level URL constants ──────────────────────────────────────────────────

describe('config: URL constants', () => {
  test('API_URL is the heatsync.org origin (https)', () => {
    expect(CONFIG.API_URL).toBe('https://heatsync.org')
  })

  test('WS_URL is wss://heatsync.org', () => {
    expect(CONFIG.WS_URL).toBe('wss://heatsync.org')
  })

  test('LINK_PREVIEW_API starts with API_URL', () => {
    expect(CONFIG.LINK_PREVIEW_API.startsWith(CONFIG.API_URL)).toBe(true)
  })

  test('LIVE_STATUS_API starts with API_URL', () => {
    expect(CONFIG.LIVE_STATUS_API.startsWith(CONFIG.API_URL)).toBe(true)
  })

  test('all CDN/API URLs are https or wss strings', () => {
    const urlKeys = [
      'CDN_7TV',
      'CDN_BTTV',
      'API_7TV',
      'WS_7TV',
      'API_BTTV',
      'API_FFZ',
      'API_RESOLVE_TWITCH',
      'API_TWITCH_GQL',
      'API_TWITCH_HELIX',
      'API_RECENT_MSGS',
      'API_CHATTERINO_BADGES',
      'WS_TWITCH_IRC',
    ]
    for (const key of urlKeys) {
      const val = CONFIG[key]
      expect(typeof val, `${key} should be a string`).toBe('string')
      expect(
        val.startsWith('https://') || val.startsWith('wss://'),
        `${key} should start with https:// or wss://, got: ${val}`,
      ).toBe(true)
    }
  })
})

// ── TIMING object ────────────────────────────────────────────────────────────

describe('config: TIMING', () => {
  test('TIMING is an object', () => {
    expect(typeof CONFIG.TIMING).toBe('object')
    expect(CONFIG.TIMING).not.toBeNull()
  })

  const positiveTimingKeys = [
    'INVENTORY_REFRESH',
    'GLOBAL_EMOTES_REFRESH',
    'CHANNEL_EMOTES_TTL',
    'BADGES_TTL',
    'WS_CONNECT_TIMEOUT',
    'WS_HEARTBEAT_INTERVAL',
    'WS_RECONNECT_MAX_DELAY',
    'FETCH_TIMEOUT',
    'TOAST_DURATION',
    'MC_CONNECT_TIMEOUT',
    'MC_FETCH_TIMEOUT',
    'MUTE_PRUNE_INTERVAL',
  ]

  for (const key of positiveTimingKeys) {
    test(`TIMING.${key} is a positive number`, () => {
      const val = CONFIG.TIMING[key]
      expect(typeof val, `${key} should be number`).toBe('number')
      expect(val, `${key} should be > 0`).toBeGreaterThan(0)
    })
  }

  test('INVENTORY_REFRESH < GLOBAL_EMOTES_REFRESH (inventory refreshes more often)', () => {
    expect(CONFIG.TIMING.INVENTORY_REFRESH).toBeLessThan(CONFIG.TIMING.GLOBAL_EMOTES_REFRESH)
  })

  test('WS_HEARTBEAT_INTERVAL < WS_RECONNECT_MAX_DELAY * 10 (sanity: heartbeat not absurdly long)', () => {
    expect(CONFIG.TIMING.WS_HEARTBEAT_INTERVAL).toBeLessThan(CONFIG.TIMING.WS_RECONNECT_MAX_DELAY * 10)
  })
})

// ── LIMITS object ────────────────────────────────────────────────────────────

describe('config: LIMITS', () => {
  test('LIMITS is an object', () => {
    expect(typeof CONFIG.LIMITS).toBe('object')
    expect(CONFIG.LIMITS).not.toBeNull()
  })

  const positiveLimitKeys = [
    'MAX_EMOTE_NAME_LEN',
    'MAX_EMOTES_PER_SOURCE',
    'MAX_SEND_QUEUE',
    'MC_CHANNEL_MSG_BUFFER',
    'MIN_CHAT_WIDTH',
    'MAX_CHAT_WIDTH',
    'MC_EMOTE_RENDER_CHUNK',
  ]

  for (const key of positiveLimitKeys) {
    test(`LIMITS.${key} is a positive integer`, () => {
      const val = CONFIG.LIMITS[key]
      expect(typeof val, `${key} should be number`).toBe('number')
      expect(val, `${key} should be > 0`).toBeGreaterThan(0)
      expect(Number.isInteger(val), `${key} should be integer`).toBe(true)
    })
  }

  test('MAX_EMOTES_PER_SOURCE matches documented emote slot limit (5000)', () => {
    // The user-facing copy says "5000 slots" — this must stay in sync
    expect(CONFIG.LIMITS.MAX_EMOTES_PER_SOURCE).toBe(5000)
  })

  test('MIN_CHAT_WIDTH < MAX_CHAT_WIDTH', () => {
    expect(CONFIG.LIMITS.MIN_CHAT_WIDTH).toBeLessThan(CONFIG.LIMITS.MAX_CHAT_WIDTH)
  })
})

// ── SELECTORS object ─────────────────────────────────────────────────────────

describe('config: SELECTORS', () => {
  test('SELECTORS is an object', () => {
    expect(typeof CONFIG.SELECTORS).toBe('object')
  })

  // Platform-specific selector groups that the CLAUDE.md documents
  const requiredSelectorKeys = [
    'TWITCH_CHAT_CONTAINER',
    'TWITCH_CHAT_MESSAGES',
    'TWITCH_CHAT_ROOM',
    'TWITCH_CHAT_INPUT',
    'TWITCH_USERNAME',
    'KICK_CHAT_CONTAINER',
    'KICK_CHAT_MESSAGES',
    'KICK_EDITOR_INPUT',
    'YT_CHAT_CONTAINER',
    'YT_MESSAGE',
    'YT_CHAT_INPUT',
  ]

  // Selector-drift-prone keys store a fallback ARRAY (tried in order via
  // qsArray/qsaArray, src/lib/utils.js) instead of one hardcoded string.
  const arraySelectorKeys = new Set(['KICK_CHAT_CONTAINER'])

  for (const key of requiredSelectorKeys) {
    if (arraySelectorKeys.has(key)) {
      test(`SELECTORS.${key} is a non-empty array of non-empty strings`, () => {
        const val = CONFIG.SELECTORS[key]
        expect(Array.isArray(val), `${key} should be an array`).toBe(true)
        expect(val.length, `${key} should not be empty`).toBeGreaterThan(0)
        for (const sel of val) {
          expect(typeof sel, `${key} entries should be strings`).toBe('string')
          expect(sel.length, `${key} entries should not be empty`).toBeGreaterThan(0)
        }
      })
      continue
    }
    test(`SELECTORS.${key} is a non-empty string`, () => {
      const val = CONFIG.SELECTORS[key]
      expect(typeof val, `${key} should be string`).toBe('string')
      expect(val.length, `${key} should not be empty`).toBeGreaterThan(0)
    })
  }

  test('SELECTORS.KICK_IDENTITY is a non-empty array of non-empty strings', () => {
    const val = CONFIG.SELECTORS.KICK_IDENTITY
    expect(Array.isArray(val)).toBe(true)
    expect(val.length).toBeGreaterThan(0)
    for (const sel of val) {
      expect(typeof sel).toBe('string')
      expect(sel.length).toBeGreaterThan(0)
    }
  })

  test('TWITCH_CHAT_INPUT contains [data-a-target]', () => {
    // This selector is documented in CLAUDE.md — a regression here breaks input
    expect(CONFIG.SELECTORS.TWITCH_CHAT_INPUT).toContain('[data-a-target')
  })

  test('YT_CHAT_CONTAINER references yt-live-chat elements', () => {
    expect(CONFIG.SELECTORS.YT_CHAT_CONTAINER).toContain('yt-live-chat')
  })
})

// ── CLASSES object ───────────────────────────────────────────────────────────

describe('config: CLASSES', () => {
  test('CLASSES is an object', () => {
    expect(typeof CONFIG.CLASSES).toBe('object')
  })

  const requiredClassKeys = [
    'EMOTE_WRAPPER',
    'EMOTE_IMG',
    'EMOTE_OVERLAY',
    'MC_CONTAINER',
    'MC_INPUT',
    'MC_TABBAR',
    'MENTIONED',
    'CHAT_COLLAPSED',
  ]

  for (const key of requiredClassKeys) {
    test(`CLASSES.${key} is a non-empty string`, () => {
      const val = CONFIG.CLASSES[key]
      expect(typeof val, `${key} should be string`).toBe('string')
      expect(val.length, `${key} should not be empty`).toBeGreaterThan(0)
    })
  }

  test('CLASSES values do not contain spaces (CSS class names are single tokens)', () => {
    for (const [key, val] of Object.entries(CONFIG.CLASSES)) {
      expect(val.includes(' '), `CLASSES.${key} should not contain spaces`).toBe(false)
    }
  })
})

// ── Z_INDEX object ───────────────────────────────────────────────────────────

describe('config: Z_INDEX', () => {
  test('Z_INDEX is an object', () => {
    expect(typeof CONFIG.Z_INDEX).toBe('object')
  })

  const requiredZKeys = [
    'EMOTE_PREVIEW',
    'TOAST',
    'AUTOCOMPLETE',
    'MC_PANEL',
    'MC_EMOTE_PICKER',
    'MC_CONTEXT_MENU',
    'MC_RESIZE_OVERLAY',
  ]

  for (const key of requiredZKeys) {
    test(`Z_INDEX.${key} is a positive integer`, () => {
      const val = CONFIG.Z_INDEX[key]
      expect(typeof val, `${key} should be number`).toBe('number')
      expect(Number.isInteger(val), `${key} should be integer`).toBe(true)
      expect(val, `${key} should be > 0`).toBeGreaterThan(0)
    })
  }

  test('MC_CONTEXT_MENU z-index is among the highest (should be on top)', () => {
    const vals = Object.values(CONFIG.Z_INDEX)
    const max = Math.max(...vals)
    expect(CONFIG.Z_INDEX.MC_CONTEXT_MENU).toBe(max)
  })

  test('MC_RESIZE_OVERLAY z-index equals MC_CONTEXT_MENU (both need to be top-most)', () => {
    expect(CONFIG.Z_INDEX.MC_RESIZE_OVERLAY).toBe(CONFIG.Z_INDEX.MC_CONTEXT_MENU)
  })

  test('MC_PANEL z-index is below MC_EMOTE_PICKER (picker floats above panel)', () => {
    expect(CONFIG.Z_INDEX.MC_PANEL).toBeLessThan(CONFIG.Z_INDEX.MC_EMOTE_PICKER)
  })
})
