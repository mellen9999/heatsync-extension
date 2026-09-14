import { describe, expect, test } from 'bun:test'
import {
  boostReadability,
  debounce,
  escapeHtml,
  safeUrl,
  sanitizeUiSettings,
  throttle,
  truncateSafe,
  UI_SYNC_BLOCKLIST,
} from '../src/lib/utils.js'

// DOM-dependent — covered by browser smoke test:
//   createElement, getFiber, findComponent

// ── escapeHtml edge cases (existing tests cover basic &<>"' and null/undefined/number) ──

describe('escapeHtml — additional edge cases', () => {
  test('empty string returns empty string', () => {
    expect(escapeHtml('')).toBe('')
  })

  test('all 5 entities in one string', () => {
    const out = escapeHtml(`& < > " '`)
    expect(out).toBe('&amp; &lt; &gt; &quot; &#x27;')
  })

  test('already-escaped input is double-escaped (no smart-escaping)', () => {
    // &amp; → &amp;amp; — intentional, defense-in-depth
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
  })

  test('unicode passes through unchanged', () => {
    expect(escapeHtml('日本語 🎉 café')).toBe('日本語 🎉 café')
  })

  test('very long string (1 MB) does not throw', () => {
    const big = 'a'.repeat(1_000_000)
    expect(() => escapeHtml(big)).not.toThrow()
    expect(escapeHtml(big).length).toBe(1_000_000)
  })

  test('boolean true coerces to "true"', () => {
    expect(escapeHtml(true)).toBe('true')
  })

  test('zero coerces to "0"', () => {
    expect(escapeHtml(0)).toBe('0')
  })

  test('nested injection payload fully escaped', () => {
    const payload = `<script>alert("xss")</script><img onerror='1'>`
    const out = escapeHtml(payload)
    expect(out).not.toMatch(/</)
    expect(out).not.toMatch(/>/)
    expect(out).not.toMatch(/"/)
    expect(out).not.toMatch(/'/)
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&quot;xss&quot;')
    expect(out).toContain('&#x27;1&#x27;')
  })
})

// ── safeUrl ───────────────────────────────────────────────────────────────────

describe('safeUrl', () => {
  test('valid https URL is returned as-is (normalized)', () => {
    const out = safeUrl('https://heatsync.org/api/emotes')
    expect(out).toContain('https://heatsync.org')
  })

  test('valid http URL is allowed', () => {
    const out = safeUrl('http://localhost:3000/test')
    expect(out).toContain('http://localhost:3000')
  })

  test('javascript: is blocked', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('')
  })

  test('JAVASCRIPT: (uppercase) is blocked', () => {
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBe('')
  })

  test('data: URI is blocked', () => {
    expect(safeUrl('data:text/html,<h1>hi</h1>')).toBe('')
  })

  test('vbscript: is blocked', () => {
    expect(safeUrl('vbscript:msgbox(1)')).toBe('')
  })

  test('blob: is blocked', () => {
    expect(safeUrl('blob:https://example.com/uuid')).toBe('')
  })

  test('file: is blocked', () => {
    expect(safeUrl('file:///etc/passwd')).toBe('')
  })

  test('about:blank is blocked', () => {
    expect(safeUrl('about:blank')).toBe('')
  })

  test('ftp:// is blocked (not http/https)', () => {
    expect(safeUrl('ftp://example.com/file')).toBe('')
  })

  test('empty string returns empty string', () => {
    expect(safeUrl('')).toBe('')
  })

  test('non-string returns empty string', () => {
    expect(safeUrl(null)).toBe('')
    expect(safeUrl(undefined)).toBe('')
    expect(safeUrl(42)).toBe('')
  })

  test('malformed URL (no protocol) returns empty string', () => {
    expect(safeUrl('not-a-url')).toBe('')
  })

  test('whitespace-padded valid URL is accepted', () => {
    const out = safeUrl('  https://cdn.heatsync.org/img.png  ')
    expect(out).toContain('https://cdn.heatsync.org')
  })
})

// ── boostReadability ──────────────────────────────────────────────────────────

describe('boostReadability', () => {
  test('non-string input is returned as-is', () => {
    expect(boostReadability(null)).toBe(null)
    expect(boostReadability(42)).toBe(42)
  })

  test('invalid hex format is returned unchanged', () => {
    expect(boostReadability('red')).toBe('red')
    expect(boostReadability('#gg0000')).toBe('#gg0000')
    expect(boostReadability('#12345')).toBe('#12345') // 5 chars — invalid
  })

  test('bright white #ffffff is already readable, returned as-is', () => {
    // relL of #fff = 1.0 — well above default 0.25
    expect(boostReadability('#ffffff')).toBe('#ffffff')
  })

  test('pure blue #0000ff (WCAG relL ≈ 0.07) gets boosted', () => {
    const out = boostReadability('#0000ff')
    // should NOT return the original — too dark perceptually
    expect(out).not.toBe('#0000ff')
    // must still be a valid #rrggbb hex
    expect(out).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test('pure red #ff0000 (raw relL ≈ 0.213) gets boosted above 0.25', () => {
    // raw relL = 0.2126 * 1.0 = 0.2126 < 0.25 → should boost
    // NOTE: WCAG proper uses gamma-expanded channels; boostReadability uses raw
    // 0-1 values (no gamma expansion), which is a documented simplification.
    // This test verifies the ACTUAL threshold used by the function.
    const out = boostReadability('#ff0000')
    expect(out).not.toBe('#ff0000')
    expect(out).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test('3-char shorthand #fff is handled', () => {
    expect(boostReadability('#fff')).toBe('#fff')
  })

  test('3-char shorthand dark color gets boosted', () => {
    const out = boostReadability('#00f') // same as #0000ff
    expect(out).not.toBe('#00f')
    expect(out).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test('heatsync orange #ff8700 (relL ≈ 0.27) passes threshold', () => {
    // 0.2126*(1) + 0.7152*(0.529) + 0.0722*(0) ≈ 0.2126 + 0.378 ≈ 0.591 → above 0.25
    expect(boostReadability('#ff8700')).toBe('#ff8700')
  })

  test('custom minRelL=0 never boosts anything', () => {
    expect(boostReadability('#000000', 0)).toBe('#000000')
  })

  // POTENTIAL GAP: #000000 has relL=0, below default 0.25, but all channels are 0
  // so saturation=0, hue=0 → achromatic; boost loop starts at max(l=0, 0.5)=0.5
  // meaning black gets lifted to a very light gray — may surprise callers expecting
  // pure black to stay black. No bug per se, but worth documenting.
})

// ── debounce ──────────────────────────────────────────────────────────────────

describe('debounce', () => {
  test('fn is not called immediately on first invoke', async () => {
    let calls = 0
    const d = debounce(() => {
      calls++
    }, 20)
    d()
    expect(calls).toBe(0)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(1)
  })

  test('burst of calls collapses to one invocation', async () => {
    let calls = 0
    const d = debounce(() => {
      calls++
    }, 30)
    d()
    d()
    d()
    d()
    d()
    expect(calls).toBe(0)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(1)
  })

  test('last arg wins after burst', async () => {
    let last = null
    const d = debounce((v) => {
      last = v
    }, 30)
    d('a')
    d('b')
    d('c')
    await new Promise((r) => setTimeout(r, 50))
    expect(last).toBe('c')
  })

  test('two distinct bursts each fire once', async () => {
    let calls = 0
    const d = debounce(() => {
      calls++
    }, 20)
    d()
    d()
    await new Promise((r) => setTimeout(r, 40))
    d()
    d()
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toBe(2)
  })

  test('default delay is ~100ms', async () => {
    let calls = 0
    const d = debounce(() => {
      calls++
    }) // no ms arg
    d()
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0) // not fired yet at 50ms
    await new Promise((r) => setTimeout(r, 70))
    expect(calls).toBe(1) // fired by ~120ms total
  })
})

// ── throttle ──────────────────────────────────────────────────────────────────

describe('throttle', () => {
  test('first call fires immediately', async () => {
    let calls = 0
    const t = throttle(() => {
      calls++
    }, 50)
    t()
    expect(calls).toBe(1)
  })

  test('second call within window is suppressed (but trailing fires)', async () => {
    let calls = 0
    const t = throttle(() => {
      calls++
    }, 50)
    t() // fires immediately → calls=1
    t() // within window → queued as trailing
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 70))
    // trailing call should have fired
    expect(calls).toBe(2)
  })

  test('rapid burst fires leading + one trailing', async () => {
    let calls = 0
    const t = throttle(() => {
      calls++
    }, 40)
    t()
    t()
    t()
    t()
    t()
    await new Promise((r) => setTimeout(r, 60))
    // leading (1) + trailing (1) = 2
    expect(calls).toBe(2)
  })

  test('trailing call receives latest args', async () => {
    let last = null
    const t = throttle((v) => {
      last = v
    }, 40)
    t('a') // leading
    t('b') // within window
    t('c') // overwrites pending trailing arg
    await new Promise((r) => setTimeout(r, 60))
    expect(last).toBe('c')
  })

  test('after window expires, next call fires immediately again', async () => {
    let calls = 0
    const t = throttle(() => {
      calls++
    }, 30)
    t()
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 50))
    t()
    expect(calls).toBe(2)
  })
})

// ── UI_SYNC_BLOCKLIST ─────────────────────────────────────────────────────────

describe('UI_SYNC_BLOCKLIST', () => {
  test('is a Set', () => {
    expect(UI_SYNC_BLOCKLIST).toBeInstanceOf(Set)
  })

  test('is non-empty', () => {
    expect(UI_SYNC_BLOCKLIST.size).toBeGreaterThan(0)
  })

  test('contains platformFilters (per-tab map — too large for sync quota)', () => {
    expect(UI_SYNC_BLOCKLIST.has('platformFilters')).toBe(true)
  })

  test('contains keywordHighlights (free-form text — too large for sync quota)', () => {
    expect(UI_SYNC_BLOCKLIST.has('keywordHighlights')).toBe(true)
  })

  test('contains chatFilterRules (JSON array — too large for sync quota)', () => {
    expect(UI_SYNC_BLOCKLIST.has('chatFilterRules')).toBe(true)
  })

  test('has exactly the documented entries (no silent additions)', () => {
    // guards against accidental expansion; update this test if blocklist grows
    expect(UI_SYNC_BLOCKLIST.size).toBe(3)
  })
})

// ── sanitizeUiSettings ────────────────────────────────────────────────────────

describe('sanitizeUiSettings', () => {
  test('returns {} for null', () => {
    expect(sanitizeUiSettings(null)).toEqual({})
  })

  test('returns {} for undefined', () => {
    expect(sanitizeUiSettings(undefined)).toEqual({})
  })

  test('returns {} for array input', () => {
    expect(sanitizeUiSettings(['a', 'b'])).toEqual({})
  })

  test('returns {} for non-object primitives', () => {
    expect(sanitizeUiSettings('hello')).toEqual({})
    expect(sanitizeUiSettings(42)).toEqual({})
  })

  test('passes through valid plain keys', () => {
    const out = sanitizeUiSettings({ fontSize: '14', zebra: true })
    expect(out.fontSize).toBe('14')
    expect(out.zebra).toBe(true)
  })

  test('strips numeric-string keys (corruption marker)', () => {
    const out = sanitizeUiSettings({ 0: 'bad', validKey: 'ok' })
    expect(out).not.toHaveProperty('0')
    expect(out.validKey).toBe('ok')
  })

  test('strips __proto__ key (prototype pollution guard)', () => {
    // Build an object that has __proto__ as an OWN string property
    const obj = { safe: 'yes' }
    Object.defineProperty(obj, '__proto__', { value: 'bad', enumerable: true, configurable: true })
    const out = sanitizeUiSettings(obj)
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
    expect(out.safe).toBe('yes')
  })

  test('strips constructor key with function value', () => {
    // { constructor: fn } — function value gets stripped, not the key name rule
    const input = {}
    Object.defineProperty(input, 'constructor', { value: () => {}, enumerable: true, configurable: true })
    const out = sanitizeUiSettings(input)
    // function values are stripped before the key-name guard fires,
    // so own 'constructor' must not appear in output
    expect(Object.hasOwn(out, 'constructor')).toBe(false)
  })

  test('strips function values', () => {
    const out = sanitizeUiSettings({ fn: () => 'bad', ok: 'good' })
    expect(out).not.toHaveProperty('fn')
    expect(out.ok).toBe('good')
  })

  test('strips symbol values', () => {
    const out = sanitizeUiSettings({ sym: Symbol('x'), ok: 'good' })
    expect(out).not.toHaveProperty('sym')
    expect(out.ok).toBe('good')
  })

  test('strips strings longer than 4096 chars', () => {
    const big = 'x'.repeat(4097)
    const out = sanitizeUiSettings({ big, small: 'ok' })
    expect(out).not.toHaveProperty('big')
    expect(out.small).toBe('ok')
  })

  test('allows strings at exactly 4096 chars', () => {
    const exact = 'x'.repeat(4096)
    const out = sanitizeUiSettings({ exact })
    expect(out.exact).toBe(exact)
  })

  test('strips objects whose JSON serialization exceeds 6144 bytes', () => {
    const big = { data: 'y'.repeat(6145) }
    const out = sanitizeUiSettings({ big, small: 'ok' })
    expect(out).not.toHaveProperty('big')
    expect(out.small).toBe('ok')
  })

  test('strips platformFilters (blocklisted)', () => {
    const out = sanitizeUiSettings({ platformFilters: { twitch: true }, ok: 1 })
    expect(out).not.toHaveProperty('platformFilters')
    expect(out.ok).toBe(1)
  })

  test('strips keywordHighlights (blocklisted)', () => {
    const out = sanitizeUiSettings({ keywordHighlights: 'mellen', ok: 1 })
    expect(out).not.toHaveProperty('keywordHighlights')
    expect(out.ok).toBe(1)
  })

  test('strips key with length > 64 chars', () => {
    const longKey = 'k'.repeat(65)
    const out = sanitizeUiSettings({ [longKey]: 'val', ok: 1 })
    expect(out).not.toHaveProperty(longKey)
    expect(out.ok).toBe(1)
  })

  test('strips empty string key', () => {
    const out = sanitizeUiSettings({ '': 'bad', ok: 1 })
    expect(out).not.toHaveProperty('')
    expect(out.ok).toBe(1)
  })

  test('does not mutate input object', () => {
    const input = { platformFilters: { twitch: true }, fontSize: '14' }
    const frozen = Object.freeze(input)
    const out = sanitizeUiSettings(frozen)
    // if mutation attempted on frozen obj it would throw in strict mode
    expect(out).not.toHaveProperty('platformFilters')
    expect(out.fontSize).toBe('14')
  })

  test('null value is preserved (falsy but valid data)', () => {
    const out = sanitizeUiSettings({ nullable: null })
    expect(out).toHaveProperty('nullable')
    expect(out.nullable).toBe(null)
  })

  test('passes through numeric and boolean values', () => {
    const out = sanitizeUiSettings({ count: 42, flag: false })
    expect(out.count).toBe(42)
    expect(out.flag).toBe(false)
  })

  // POTENTIAL GAP: prototype-inherited keys are excluded via hasOwnProperty,
  // but if the input's prototype is Object (normal case), inherited Object
  // keys like 'toString' are silently skipped. This is correct behavior,
  // but any caller using Object.create(someProto) may lose expected keys.
})

describe('truncateSafe', () => {
  test('string at or under limit returned unchanged', () => {
    expect(truncateSafe('abc', 3)).toBe('abc')
    expect(truncateSafe('ab', 3)).toBe('ab')
  })

  test('plain over-limit string cut at n', () => {
    expect(truncateSafe('abcdef', 4)).toBe('abcd')
  })

  test('surrogate pair straddling the boundary is dropped whole', () => {
    const s = `${'a'.repeat(3)}😀b`
    const out = truncateSafe(s, 4)
    expect(out).toBe('aaa')
    expect(out.isWellFormed()).toBe(true)
  })

  test('pair ending exactly at the boundary is kept', () => {
    const s = `${'a'.repeat(3)}😀b`
    const out = truncateSafe(s, 5)
    expect(out).toBe('aaa😀')
    expect(out.isWellFormed()).toBe(true)
  })

  test('emoji-only string never yields a lone surrogate', () => {
    const s = '😀'.repeat(10)
    for (let n = 1; n <= 20; n++) {
      expect(truncateSafe(s, n).isWellFormed()).toBe(true)
    }
  })
})
