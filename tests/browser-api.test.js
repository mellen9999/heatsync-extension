/**
 * Unit tests for src/lib/browser-api.js
 *
 * The module evaluates chrome/browser detection at module-load time (top-level),
 * and Bun deduplicates ESM imports by resolved file path (ignoring query params).
 * This means we get exactly ONE module instance per test run, loaded in the Bun
 * environment which has neither `chrome` nor `browser` globals.
 *
 * Test strategy:
 *   - API shape + exported symbols always work regardless of environment
 *   - Null-API graceful fallbacks: no-throw, sensible return values
 *   - Pure helpers: t(), bidiDir(), getI18nLocale(), I18N_LOCALE_NAMES, platform
 *   - i18n placeholders via t() with an injected override
 *   - Storage/runtime/tabs onChanged/onMessage passthrough (no-throw)
 *   - isContextValid() returns false when no rawApi
 *
 * NOTE: The Chrome promisify() path (callback → Promise) cannot be exercised
 * in the Bun test environment because rawApi is captured at module load time
 * (when chrome is undefined). That path is exercised in real-browser E2E only.
 * It is documented in POTENTIAL_NOTE below.
 */

import { describe, expect, test } from 'bun:test'
import api, {
  bidiDir,
  getI18nLocale,
  hydrateI18n,
  I18N_LOCALE_NAMES,
  initI18n,
  isContextValid,
  api as namedApi,
  platform,
  runtime,
  setI18nLocale,
  storage,
  t,
  tabs,
} from '../src/lib/browser-api.js'

// ── export shape ─────────────────────────────────────────────────────────────

describe('browser-api: exports', () => {
  test('default export is an object', () => {
    expect(typeof api).toBe('object')
    expect(api).not.toBeNull()
  })

  test('named api export equals default export', () => {
    expect(namedApi).toBe(api)
  })

  test('api has storage, runtime, tabs, platform, isContextValid, raw keys', () => {
    expect(typeof api.storage).toBe('object')
    expect(typeof api.runtime).toBe('object')
    expect(typeof api.tabs).toBe('object')
    expect(typeof api.platform).toBe('object')
    expect(typeof api.isContextValid).toBe('function')
    // raw can be null in environments without chrome/browser
    expect('raw' in api).toBe(true)
  })

  test('all named function exports are functions', () => {
    expect(typeof t).toBe('function')
    expect(typeof hydrateI18n).toBe('function')
    expect(typeof initI18n).toBe('function')
    expect(typeof getI18nLocale).toBe('function')
    expect(typeof setI18nLocale).toBe('function')
    expect(typeof bidiDir).toBe('function')
    expect(typeof isContextValid).toBe('function')
  })
})

// ── platform object ───────────────────────────────────────────────────────────

describe('browser-api: platform', () => {
  test('platform has isFirefox boolean', () => {
    expect(typeof platform.isFirefox).toBe('boolean')
  })

  test('platform has isChrome boolean', () => {
    expect(typeof platform.isChrome).toBe('boolean')
  })

  test('platform has name string', () => {
    expect(typeof platform.name).toBe('string')
    expect(platform.name.length).toBeGreaterThan(0)
  })

  test('platform has manifestVersion number', () => {
    expect(typeof platform.manifestVersion).toBe('number')
    expect(platform.manifestVersion).toBeGreaterThan(0)
  })

  test('isFirefox and isChrome are mutually exclusive', () => {
    expect(platform.isFirefox && platform.isChrome).toBe(false)
  })

  test('platform.name matches the detected browser', () => {
    if (platform.isFirefox) expect(platform.name).toBe('firefox')
    else expect(platform.name).toBe('chrome')
  })

  test('Firefox gets MV2, Chrome/default gets MV3', () => {
    if (platform.isFirefox) expect(platform.manifestVersion).toBe(2)
    else expect(platform.manifestVersion).toBe(3)
  })
})

// ── null-API graceful fallbacks ───────────────────────────────────────────────

describe('browser-api: null-API graceful handling (Bun env = no chrome/browser)', () => {
  // Fail LOUD if another test file left a chrome global behind. browser-api
  // binds rawApi at import time, so a leaked stub silently rewires every test
  // below — and if that stub returns promises instead of calling chrome's
  // callback, they don't fail, they HANG (bun then never exits, and the
  // release workflow burns its 6h cap producing nothing). One assertion turns
  // that into an instant, readable failure.
  test('no test file has leaked a chrome/browser global into this one', () => {
    expect(typeof globalThis.chrome).toBe('undefined')
    expect(typeof globalThis.browser).toBe('undefined')
  })

  test('isContextValid returns false', () => {
    // rawApi is null → runtime.id is undefined → false
    expect(isContextValid()).toBe(false)
  })

  test('storage.local.get returns {} without throwing', async () => {
    const result = await storage.local.get('someKey')
    expect(result).toEqual({})
  })

  test('missing storage API stays quiet when no runtime exists (not ctx-death)', async () => {
    // rawApi is null here — the MAIN-world / fresh-boot shape. Warning about
    // "context invalidated" in this state was misdiagnosis noise; the warn
    // must only fire when a runtime object exists with its id gone.
    const origWarn = console.warn
    const warns = []
    console.warn = (...args) => warns.push(args.join(' '))
    try {
      await storage.local.get('someKey')
      await storage.local.set({ foo: 'bar' })
    } finally {
      console.warn = origWarn
    }
    expect(warns.filter((w) => w.includes('Storage API not available'))).toEqual([])
  })

  test('storage.local.get with array key returns {}', async () => {
    const result = await storage.local.get(['a', 'b'])
    expect(result).toEqual({})
  })

  test('storage.local.set returns undefined without throwing', async () => {
    const result = await storage.local.set({ foo: 'bar' })
    expect(result).toBeUndefined()
  })

  test('storage.local.remove does not throw', async () => {
    await expect(storage.local.remove('key')).resolves.toBeUndefined()
  })

  test('storage.local.clear does not throw', async () => {
    await expect(storage.local.clear()).resolves.toBeUndefined()
  })

  test('storage.sync.get returns {} without throwing', async () => {
    const result = await storage.sync.get('foo')
    expect(result).toEqual({})
  })

  test('storage.sync.set returns undefined without throwing', async () => {
    await expect(storage.sync.set({ x: 1 })).resolves.toBeUndefined()
  })

  test('runtime.sendMessage returns null without throwing', async () => {
    const result = await runtime.sendMessage({ type: 'ping' })
    expect(result).toBeNull()
  })

  test('runtime.getURL returns path unchanged when no rawApi', () => {
    expect(runtime.getURL('icons/icon128.png')).toBe('icons/icon128.png')
  })

  test('runtime.id fallback is "heatsync-extension"', () => {
    expect(runtime.id).toBe('heatsync-extension')
  })

  test('runtime.lastError is undefined/null when no rawApi', () => {
    expect(runtime.lastError == null).toBe(true)
  })

  test('tabs.query returns [] without throwing', async () => {
    const result = await tabs.query({ active: true, currentWindow: true })
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBe(0)
  })

  test('tabs.sendMessage returns null without throwing', async () => {
    const result = await tabs.sendMessage(1, { type: 'test' })
    expect(result).toBeNull()
  })

  test('tabs.create returns null without throwing', async () => {
    const result = await tabs.create({ url: 'https://example.com' })
    expect(result).toBeNull()
  })
})

// ── event listener passthroughs (no throw when no API) ───────────────────────

describe('browser-api: event listener no-ops', () => {
  test('storage.onChanged.addListener does not throw', () => {
    expect(() => storage.onChanged.addListener(() => {})).not.toThrow()
  })

  test('storage.onChanged.removeListener does not throw', () => {
    expect(() => storage.onChanged.removeListener(() => {})).not.toThrow()
  })

  test('runtime.onMessage.addListener does not throw', () => {
    expect(() => runtime.onMessage.addListener(() => {})).not.toThrow()
  })

  test('runtime.onMessage.removeListener does not throw', () => {
    expect(() => runtime.onMessage.removeListener(() => {})).not.toThrow()
  })
})

// ── i18n helpers ──────────────────────────────────────────────────────────────

describe('browser-api: t() pure behavior', () => {
  test('t() returns key for unknown key (no rawApi, no override)', () => {
    expect(t('settings_title')).toBe('settings_title')
  })

  test('t() returns empty string for empty string key', () => {
    expect(t('')).toBe('')
  })

  test('t() returns empty string for null key', () => {
    expect(t(null)).toBe('')
  })

  test('t() returns empty string for undefined key', () => {
    expect(t(undefined)).toBe('')
  })

  test('t() returns key for @@ prefix when no rawApi', () => {
    const result = t('@@extension_id')
    expect(typeof result).toBe('string')
    expect(result).toBe('@@extension_id') // fallback: return key
  })

  test('getI18nLocale returns empty string by default', () => {
    expect(getI18nLocale()).toBe('')
  })

  test('bidiDir returns "ltr" when no locale override and no rawApi', () => {
    expect(bidiDir()).toBe('ltr')
  })
})

describe('browser-api: I18N_LOCALE_NAMES', () => {
  test('is an object', () => {
    expect(typeof I18N_LOCALE_NAMES).toBe('object')
    expect(I18N_LOCALE_NAMES).not.toBeNull()
  })

  test('has empty string key for auto', () => {
    expect(typeof I18N_LOCALE_NAMES['']).toBe('string')
    expect(I18N_LOCALE_NAMES['']).toContain('Auto')
  })

  test('has English entry', () => {
    expect(I18N_LOCALE_NAMES['en']).toBe('English')
  })

  test('has major languages present', () => {
    const expectedKeys = ['de', 'fr', 'es', 'ja', 'ko', 'zh_CN', 'ru', 'pt_BR']
    for (const key of expectedKeys) {
      expect(typeof I18N_LOCALE_NAMES[key], `locale ${key} should exist`).toBe('string')
      expect(I18N_LOCALE_NAMES[key].length, `locale ${key} name should not be empty`).toBeGreaterThan(0)
    }
  })

  test('has at least 20 entries (reasonably complete locale list)', () => {
    expect(Object.keys(I18N_LOCALE_NAMES).length).toBeGreaterThanOrEqual(20)
  })
})

// ── POTENTIAL NOTE ────────────────────────────────────────────────────────────
// The Chrome callback → Promise promisify() path is not testable here because
// rawApi is captured at module load time (no chrome in Bun). The promisify()
// function itself is not exported. Coverage for that path requires either:
//   a) E2E tests running in a real Chrome extension context, or
//   b) Extracting promisify() into its own exportable util.
// The Firefox path (already-Promise APIs) also can't be toggled post-load.
// Both paths are low-risk: trivial wrappers, no state, no branching logic.
