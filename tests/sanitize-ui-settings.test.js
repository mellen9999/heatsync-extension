import { describe, expect, test } from 'bun:test'
import {
  DEVICE_LOCAL_KEYS,
  estimateSettingSize,
  isLargeKeySyncEligible,
  LARGE_KEY_SYNC_MAX,
  OVERFLOW_MIRROR_KEYS,
  sanitizeUiSettings,
  UI_SYNC_BLOCKLIST,
} from '../src/lib/utils.js'

// ── edge inputs: must not throw ───────────────────────────────────────────────

describe('edge inputs', () => {
  test('null returns {}', () => {
    expect(sanitizeUiSettings(null)).toEqual({})
  })

  test('undefined returns {}', () => {
    expect(sanitizeUiSettings(undefined)).toEqual({})
  })

  test('number returns {}', () => {
    expect(sanitizeUiSettings(42)).toEqual({})
  })

  test('string returns {}', () => {
    expect(sanitizeUiSettings('hello')).toEqual({})
  })

  test('array returns {}', () => {
    expect(sanitizeUiSettings(['a', 'b'])).toEqual({})
  })

  test('empty object returns {}', () => {
    expect(sanitizeUiSettings({})).toEqual({})
  })

  test('does not mutate input', () => {
    const input = { zebra: true, platformFilters: { twitch: true } }
    const frozen = Object.freeze(input)
    // should not throw (no mutation attempt) and should strip blocklist key
    const out = sanitizeUiSettings(frozen)
    expect(out).not.toHaveProperty('platformFilters')
    expect(out).toHaveProperty('zebra', true)
  })
})

// ── valid settings pass through unchanged ────────────────────────────────────

describe('valid settings round-trip', () => {
  test('bool setting passes through as-is', () => {
    const input = { zebra: true }
    expect(sanitizeUiSettings(input)).toEqual({ zebra: true })
  })

  test('numeric setting passes through as-is', () => {
    const input = { mentionSoundVolume: 0.5 }
    expect(sanitizeUiSettings(input)).toEqual({ mentionSoundVolume: 0.5 })
  })

  test('null value passes through (explicit opt-out)', () => {
    const input = { someKey: null }
    expect(sanitizeUiSettings(input)).toEqual({ someKey: null })
  })

  test('array value passes through when under size limit', () => {
    const input = { hiddenTabs: ['pinned', 'feed'] }
    expect(sanitizeUiSettings(input)).toEqual({ hiddenTabs: ['pinned', 'feed'] })
  })

  test('multiple valid settings all pass through', () => {
    const input = {
      zebra: false,
      timestamps: true,
      avatars: true,
      mentionSoundVolume: 0,
      fontFamily: 'monospace',
    }
    expect(sanitizeUiSettings(input)).toEqual(input)
  })

  test('returns a new object (never the same reference)', () => {
    const input = { zebra: true }
    const out = sanitizeUiSettings(input)
    expect(out).not.toBe(input)
  })
})

// ── blocklist keys are stripped ───────────────────────────────────────────────

describe('blocklist keys', () => {
  test('platformFilters is stripped', () => {
    const out = sanitizeUiSettings({ platformFilters: { twitch: true }, zebra: true })
    expect(out).not.toHaveProperty('platformFilters')
    expect(out).toHaveProperty('zebra', true)
  })

  test('keywordHighlights is stripped', () => {
    const out = sanitizeUiSettings({ keywordHighlights: ['foo', 'bar'], zebra: false })
    expect(out).not.toHaveProperty('keywordHighlights')
    expect(out).toHaveProperty('zebra', false)
  })

  test('all UI_SYNC_BLOCKLIST members are stripped', () => {
    const input = {}
    for (const k of UI_SYNC_BLOCKLIST) input[k] = 'value'
    input.zebra = true
    const out = sanitizeUiSettings(input)
    for (const k of UI_SYNC_BLOCKLIST) {
      expect(out).not.toHaveProperty(k)
    }
    expect(out).toHaveProperty('zebra', true)
  })
})

// ── prototype pollution prevention ───────────────────────────────────────────

describe('prototype pollution keys', () => {
  test('__proto__ key is stripped', () => {
    const input = Object.create(null)
    input.__proto__ = { injected: true }
    input.zebra = true
    const out = sanitizeUiSettings(input)
    // use Object.keys — toHaveProperty traverses the prototype chain
    expect(Object.keys(out)).not.toContain('__proto__')
    expect(out).toHaveProperty('zebra', true)
  })

  test('constructor key is stripped', () => {
    const out = sanitizeUiSettings({ constructor: 'evil', zebra: true })
    // use Object.keys — toHaveProperty resolves Object.prototype.constructor
    expect(Object.keys(out)).not.toContain('constructor')
    expect(out).toHaveProperty('zebra', true)
  })

  test('prototype key is stripped', () => {
    const out = sanitizeUiSettings({ prototype: { x: 1 }, zebra: true })
    expect(Object.keys(out)).not.toContain('prototype')
    expect(out).toHaveProperty('zebra', true)
  })
})

// ── numeric-string keys are stripped (corruption marker) ─────────────────────

describe('numeric-string keys', () => {
  test('key "0" is stripped', () => {
    const out = sanitizeUiSettings({ 0: 'bad', zebra: true })
    expect(out).not.toHaveProperty('0')
    expect(out).toHaveProperty('zebra', true)
  })

  test('key "123" is stripped', () => {
    const out = sanitizeUiSettings({ 123: 'corrupt', zebra: true })
    expect(out).not.toHaveProperty('123')
  })

  test('alphanumeric key "v2" is kept (not pure digits)', () => {
    const out = sanitizeUiSettings({ v2: 'ok' })
    expect(out).toHaveProperty('v2', 'ok')
  })
})

// ── key length limits ─────────────────────────────────────────────────────────

describe('key length limits', () => {
  test('empty-string key is stripped', () => {
    // Object.defineProperty needed to set '' key cleanly
    const input = {}
    Object.defineProperty(input, '', { value: 'bad', enumerable: true, configurable: true })
    const out = sanitizeUiSettings(input)
    expect(Object.keys(out)).not.toContain('')
  })

  test('65-char key is stripped', () => {
    const longKey = 'a'.repeat(65)
    const out = sanitizeUiSettings({ [longKey]: 'too long', zebra: true })
    expect(out).not.toHaveProperty(longKey)
    expect(out).toHaveProperty('zebra', true)
  })

  test('64-char key is kept', () => {
    const maxKey = 'a'.repeat(64)
    const out = sanitizeUiSettings({ [maxKey]: 'ok' })
    expect(out).toHaveProperty(maxKey, 'ok')
  })
})

// ── non-data value types are stripped ────────────────────────────────────────

describe('non-data value types', () => {
  test('function value is stripped', () => {
    const out = sanitizeUiSettings({ cb: () => {}, zebra: true })
    expect(out).not.toHaveProperty('cb')
    expect(out).toHaveProperty('zebra', true)
  })

  test('symbol value is stripped', () => {
    const out = sanitizeUiSettings({ sym: Symbol('test'), zebra: true })
    expect(out).not.toHaveProperty('sym')
    expect(out).toHaveProperty('zebra', true)
  })
})

// ── oversized strings are stripped (>4 KB) ───────────────────────────────────

describe('oversized strings', () => {
  test('string exactly at 4096 chars is kept', () => {
    const val = 'x'.repeat(4096)
    const out = sanitizeUiSettings({ fontFamily: val })
    expect(out).toHaveProperty('fontFamily', val)
  })

  test('string at 4097 chars is stripped', () => {
    const val = 'x'.repeat(4097)
    const out = sanitizeUiSettings({ fontFamily: val, zebra: true })
    expect(out).not.toHaveProperty('fontFamily')
    expect(out).toHaveProperty('zebra', true)
  })
})

// ── oversized objects are stripped (JSON >6 KB) ───────────────────────────────

describe('oversized objects', () => {
  test('object whose JSON is <=6144 bytes is kept', () => {
    // fill an array to just under the limit
    const val = { data: 'x'.repeat(6120) }
    // JSON: {"data":"<6120 x's>"} = 9 + 6120 + 2 = ~6131 bytes, under limit
    const out = sanitizeUiSettings({ inlineNotifs: val })
    expect(out).toHaveProperty('inlineNotifs')
  })

  test('object whose JSON is >6144 bytes is stripped', () => {
    const val = { data: 'x'.repeat(6200) }
    const out = sanitizeUiSettings({ inlineNotifs: val, zebra: true })
    expect(out).not.toHaveProperty('inlineNotifs')
    expect(out).toHaveProperty('zebra', true)
  })

  test('non-serializable object (circular) is stripped', () => {
    const circular = {}
    circular.self = circular
    const out = sanitizeUiSettings({ bad: circular, zebra: true })
    expect(out).not.toHaveProperty('bad')
    expect(out).toHaveProperty('zebra', true)
  })
})

// ── inherited keys are not copied ────────────────────────────────────────────

describe('own-property filtering', () => {
  test('inherited properties are not copied', () => {
    const proto = { inheritedKey: 'evil' }
    const input = Object.create(proto)
    input.zebra = true
    const out = sanitizeUiSettings(input)
    expect(out).not.toHaveProperty('inheritedKey')
    expect(out).toHaveProperty('zebra', true)
  })
})

// ── realistic sync blob round-trip ───────────────────────────────────────────

describe('real-world sync blob', () => {
  test('full typical settings blob passes through cleanly', () => {
    const blob = {
      zebra: true,
      timestamps: false,
      avatars: true,
      linksEnabled: true,
      linkPreviewsEnabled: false,
      viMode: false,
      wysiwygEnabled: true,
      mentionSoundVolume: 0.5,
      fontFamily: 'monospace',
      fontSize: 15,
      hs_emote_size: 2,
      hs_emoji_size: 1,
      hs_notifications: true,
      hs_readable_names: false,
      hiddenTabs: ['pinned'],
      showPlatformBadges: true,
      firstChatterGlow: false,
    }
    const out = sanitizeUiSettings(blob)
    expect(out).toEqual(blob)
  })

  test('blob with mixed good/bad keys: only bad stripped', () => {
    const blob = {
      zebra: true,
      platformFilters: { twitch: true }, // blocklist
      keywordHighlights: ['foo'], // blocklist
      0: 'corrupt', // numeric key
      constructor: 'evil', // prototype pollution
      __proto__: { x: 1 }, // prototype pollution
      bigString: 'x'.repeat(5000), // oversized string
      fontFamily: 'monospace', // valid
    }
    const out = sanitizeUiSettings(blob)
    expect(out).toEqual({ zebra: true, fontFamily: 'monospace' })
  })
})

// ── POTENTIAL GAPs ────────────────────────────────────────────────────────────

// POTENTIAL GAP: sanitizeUiSettings does NOT validate value semantics —
// it accepts values of wrong types for known keys (e.g., string where bool
// expected, number out of schema range). It is purely a structural/size guard.
// Callers relying on correct types should also run coerceSettingValue from
// settings-schema.js. No assertions here — this is by design, but worth
// documenting: the two-layer defense (sanitize size/shape, coerce values)
// must be understood to use them correctly.

test('wrong-type value is NOT dropped (type coercion is schema job, not sanitize)', () => {
  // POTENTIAL GAP: a string "true" where bool expected passes through,
  // because sanitizeUiSettings is type-agnostic. Coercion is the caller's job.
  const out = sanitizeUiSettings({ zebra: 'true' })
  expect(out).toHaveProperty('zebra', 'true')
})

test('out-of-range number is NOT clamped (clamping is schema job, not sanitize)', () => {
  // POTENTIAL GAP: mentionSoundVolume=99 is outside schema range [0,1]
  // but sanitizeUiSettings passes it through — it only guards size, not range.
  const out = sanitizeUiSettings({ mentionSoundVolume: 99 })
  expect(out).toHaveProperty('mentionSoundVolume', 99)
})

// ── large-key server sync eligibility ────────────────────────────────────────
// keywordHighlights/chatFilterRules are UI_SYNC_BLOCKLIST members (never enter
// chrome.storage.sync) that ARE real cross-device prefs and ride the
// server-backed ws ui-state channel, size-capped. platformFilters is the one
// blocklist member that's genuinely per-device and excluded from that channel
// entirely — see DEVICE_LOCAL_KEYS.

describe('DEVICE_LOCAL_KEYS', () => {
  test('is a subset of UI_SYNC_BLOCKLIST', () => {
    for (const k of DEVICE_LOCAL_KEYS) expect(UI_SYNC_BLOCKLIST.has(k)).toBe(true)
  })

  test('platformFilters is device-local; keywordHighlights/chatFilterRules are not', () => {
    expect(DEVICE_LOCAL_KEYS.has('platformFilters')).toBe(true)
    expect(DEVICE_LOCAL_KEYS.has('keywordHighlights')).toBe(false)
    expect(DEVICE_LOCAL_KEYS.has('chatFilterRules')).toBe(false)
  })
})

describe('OVERFLOW_MIRROR_KEYS', () => {
  test('has exactly one mirror entry per UI_SYNC_BLOCKLIST member', () => {
    for (const k of UI_SYNC_BLOCKLIST) expect(OVERFLOW_MIRROR_KEYS).toHaveProperty(k)
    expect(Object.keys(OVERFLOW_MIRROR_KEYS).sort()).toEqual([...UI_SYNC_BLOCKLIST].sort())
  })

  test('mirror names match the known chrome.storage.local overflow keys', () => {
    expect(OVERFLOW_MIRROR_KEYS.platformFilters).toBe('platform_filters')
    expect(OVERFLOW_MIRROR_KEYS.keywordHighlights).toBe('keyword_highlights')
    expect(OVERFLOW_MIRROR_KEYS.chatFilterRules).toBe('chat_filter_rules')
  })
})

describe('estimateSettingSize', () => {
  test('measures string length', () => {
    expect(estimateSettingSize('x'.repeat(100))).toBe(100)
  })
  test('measures JSON length for objects/arrays', () => {
    expect(estimateSettingSize(['a', 'b'])).toBe(JSON.stringify(['a', 'b']).length)
  })
  test('circular reference is Infinity (fail closed)', () => {
    const circular = {}
    circular.self = circular
    expect(estimateSettingSize(circular)).toBe(Infinity)
  })
})

describe('isLargeKeySyncEligible', () => {
  test('keywordHighlights under the cap is eligible', () => {
    expect(isLargeKeySyncEligible('keywordHighlights', 'foo\nbar')).toBe(true)
  })
  test('chatFilterRules under the cap is eligible', () => {
    expect(isLargeKeySyncEligible('chatFilterRules', '[]')).toBe(true)
  })
  test('keywordHighlights over LARGE_KEY_SYNC_MAX is not eligible', () => {
    expect(isLargeKeySyncEligible('keywordHighlights', 'x'.repeat(LARGE_KEY_SYNC_MAX + 1))).toBe(false)
  })
  test('value exactly at the cap is eligible (boundary)', () => {
    expect(isLargeKeySyncEligible('chatFilterRules', 'x'.repeat(LARGE_KEY_SYNC_MAX))).toBe(true)
  })
  test('platformFilters is never eligible regardless of size (device-local)', () => {
    expect(isLargeKeySyncEligible('platformFilters', { a: 1 })).toBe(false)
  })
  test('a non-blocklist key is never "eligible" (it syncs via chrome.storage.sync directly, not this path)', () => {
    expect(isLargeKeySyncEligible('zebra', true)).toBe(false)
  })
})
