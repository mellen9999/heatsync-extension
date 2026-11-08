/**
 * Tests for safeUrl() — the extension's sole XSS/SSRF protocol gate.
 * Applied to every externally-sourced URL: emote CDNs, avatars, badge SVGs, feed embeds.
 *
 * Contract (verified against src/lib/utils.js):
 *   - SAFE: returns u.href (WHATWG-normalized string, e.g. lowercased host, trailing slash)
 *   - UNSAFE / unparseable: returns '' (empty string)
 *   - Non-string / falsy: returns '' without throwing
 */

import { describe, expect, test } from 'bun:test'
import { safeUrl } from '../src/lib/utils.js'

// ── helpers ────────────────────────────────────────────────────────────────────

const EMPTY = ''

// ── ALLOW: http / https ────────────────────────────────────────────────────────

describe('allow: http and https URLs', () => {
  test('https basic', () => {
    // URL() normalizes: adds trailing slash to bare host
    expect(safeUrl('https://example.com')).toBe('https://example.com/')
  })

  test('http basic', () => {
    expect(safeUrl('http://example.com')).toBe('http://example.com/')
  })

  test('https with path', () => {
    expect(safeUrl('https://cdn.heatsync.org/emotes/abc123.webp')).toBe('https://cdn.heatsync.org/emotes/abc123.webp')
  })

  test('https with port, path, query, fragment', () => {
    expect(safeUrl('https://example.com:8443/path?q=1#frag')).toBe('https://example.com:8443/path?q=1#frag')
  })

  test('https with percent-encoded path', () => {
    expect(safeUrl('https://example.com/path%20with%20spaces')).toBe('https://example.com/path%20with%20spaces')
  })

  test('https uppercase host is normalized to lowercase', () => {
    // URL() lowercases host per spec
    expect(safeUrl('https://EXAMPLE.COM/Path')).toBe('https://example.com/Path')
  })

  test('https with credentials', () => {
    expect(safeUrl('https://user:pass@example.com/path')).toBe('https://user:pass@example.com/path')
  })

  test('https with trailing whitespace stripped (trim)', () => {
    expect(safeUrl('https://example.com  ')).toBe('https://example.com/')
  })

  test('https punycode IDN host', () => {
    expect(safeUrl('https://xn--nxasmq6b.com/')).toBe('https://xn--nxasmq6b.com/')
  })

  test('https unicode IDN host — normalized to punycode in u.href', () => {
    // URL() converts unicode host → punycode
    expect(safeUrl('https://例え.jp/')).toBe('https://xn--r8jz45g.jp/')
  })

  test('twitch CDN URL', () => {
    expect(safeUrl('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0')).toBe(
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0',
    )
  })

  test('7tv CDN URL', () => {
    expect(safeUrl('https://cdn.7tv.app/emote/abc/1x.webp')).toBe('https://cdn.7tv.app/emote/abc/1x.webp')
  })

  test('heatsync CDN URL', () => {
    expect(safeUrl('https://cdn.heatsync.org/emotes/abc123.webp')).toBe('https://cdn.heatsync.org/emotes/abc123.webp')
  })
})

// ── BLOCK: deny-listed schemes ─────────────────────────────────────────────────

describe('block: deny-listed dangerous schemes', () => {
  test('javascript: lowercase', () => {
    expect(safeUrl('javascript:alert(1)')).toBe(EMPTY)
  })

  test('javascript: mixed case — JavaScript:', () => {
    expect(safeUrl('JavaScript:alert(1)')).toBe(EMPTY)
  })

  test('javascript: all uppercase — JAVASCRIPT:', () => {
    expect(safeUrl('JAVASCRIPT:alert(1)')).toBe(EMPTY)
  })

  test('javascript: camelCase — JaVaScRiPt:', () => {
    expect(safeUrl('JaVaScRiPt:alert(1)')).toBe(EMPTY)
  })

  test('data: URI', () => {
    expect(safeUrl('data:text/html,<h1>xss</h1>')).toBe(EMPTY)
  })

  test('data: uppercase — DATA:', () => {
    expect(safeUrl('DATA:text/plain,x')).toBe(EMPTY)
  })

  test('vbscript: lowercase', () => {
    expect(safeUrl('vbscript:msgbox(1)')).toBe(EMPTY)
  })

  test('vbscript: uppercase — VBSCRIPT:', () => {
    expect(safeUrl('VBSCRIPT:msgbox(1)')).toBe(EMPTY)
  })

  test('blob: URL', () => {
    expect(safeUrl('blob:https://example.com/uuid')).toBe(EMPTY)
  })

  test('blob: uppercase — BLOB:', () => {
    expect(safeUrl('BLOB:https://x.com/1')).toBe(EMPTY)
  })

  test('file: lowercase', () => {
    expect(safeUrl('file:///etc/passwd')).toBe(EMPTY)
  })

  test('file: uppercase — FILE:', () => {
    expect(safeUrl('FILE:///etc/passwd')).toBe(EMPTY)
  })

  test('about:blank', () => {
    expect(safeUrl('about:blank')).toBe(EMPTY)
  })

  test('about: uppercase — ABOUT:', () => {
    expect(safeUrl('ABOUT:blank')).toBe(EMPTY)
  })
})

// ── BLOCK: schemes not on deny-list but rejected by protocol allowlist ──────────

describe('block: non-deny-listed schemes filtered by protocol allowlist', () => {
  test('mailto: rejected by protocol check', () => {
    expect(safeUrl('mailto:user@example.com')).toBe(EMPTY)
  })

  test('ftp: rejected by protocol check', () => {
    expect(safeUrl('ftp://ftp.example.com/file.txt')).toBe(EMPTY)
  })

  test('chrome: rejected by protocol check', () => {
    expect(safeUrl('chrome://settings')).toBe(EMPTY)
  })

  test('chrome-extension: rejected by protocol check', () => {
    expect(safeUrl('chrome-extension://abcdef/page.html')).toBe(EMPTY)
  })

  test('ws: rejected by protocol check', () => {
    expect(safeUrl('ws://example.com/socket')).toBe(EMPTY)
  })

  test('wss: rejected by protocol check', () => {
    expect(safeUrl('wss://example.com/socket')).toBe(EMPTY)
  })
})

// ── BLOCK: evasion attempts ────────────────────────────────────────────────────

describe('block: whitespace/encoding evasion', () => {
  test('leading spaces before javascript: — trim() strips them, deny-list catches', () => {
    expect(safeUrl('  javascript:alert(1)')).toBe(EMPTY)
  })

  test('leading tab before javascript: — trim() strips it, deny-list catches', () => {
    expect(safeUrl('\tjavascript:alert(1)')).toBe(EMPTY)
  })

  test('embedded tab inside scheme — java\\tscript:', () => {
    // WHATWG URL spec strips tab/LF/CR inside URLs; URL() normalizes to javascript:
    // protocol check catches it. Either way: must return empty.
    expect(safeUrl('java\tscript:alert(1)')).toBe(EMPTY)
  })

  test('embedded newline inside scheme — java\\nscript:', () => {
    expect(safeUrl('java\nscript:alert(1)')).toBe(EMPTY)
  })

  test('embedded CR inside scheme — java\\rscript:', () => {
    expect(safeUrl('java\rscript:alert(1)')).toBe(EMPTY)
  })

  test('leading null byte — \\x00javascript:', () => {
    // trim() does not strip null; URL() throws on it → empty
    expect(safeUrl('\x00javascript:alert(1)')).toBe(EMPTY)
  })

  test('null byte mid-scheme — javascript\\x00:', () => {
    expect(safeUrl('javascript\x00:alert(1)')).toBe(EMPTY)
  })

  test('zero-width space before javascript: — \\u200b stripped, deny-list catches', () => {
    // _INVISIBLE_RE strips U+200B before deny-list check, so head starts with 'javascript:'
    expect(safeUrl('​javascript:alert(1)')).toBe(EMPTY)
  })

  test('soft-hyphen before javascript: — \\u00ad stripped, deny-list catches', () => {
    // _INVISIBLE_RE strips U+00AD before deny-list check
    expect(safeUrl('­javascript:alert(1)')).toBe(EMPTY)
  })

  test('zero-width non-joiner inside scheme — java\\u200cscript:', () => {
    // U+200C mid-scheme stripped → 'javascript:' caught by deny-list
    expect(safeUrl('java‌script:alert(1)')).toBe(EMPTY)
  })

  test('zero-width joiner inside scheme — java\\u200dscript:', () => {
    // U+200D mid-scheme stripped → 'javascript:' caught by deny-list
    expect(safeUrl('java‍script:alert(1)')).toBe(EMPTY)
  })

  test('word joiner before data: — \\u2060data:', () => {
    // U+2060 word joiner before data: stripped → deny-list catches
    expect(safeUrl('⁠data:text/html,<h1>xss</h1>')).toBe(EMPTY)
  })

  test('BOM before javascript: — \\ufeffjavascript:', () => {
    // U+FEFF BOM stripped → deny-list catches
    expect(safeUrl('﻿javascript:alert(1)')).toBe(EMPTY)
  })

  test('null byte inside data: — dat\\x00a:', () => {
    // null stripped → 'data:' caught by deny-list
    expect(safeUrl('dat\x00a:text/html,xss')).toBe(EMPTY)
  })

  test('multiple invisible chars before vbscript: — deny-list catches after strip', () => {
    // chain of invisible chars all stripped before deny-list check
    expect(safeUrl('​­﻿vbscript:msgbox(1)')).toBe(EMPTY)
  })

  test('invisible chars between scheme letters AND prefix — file:', () => {
    // fi​le: → after strip: 'file:' → deny-list catches
    expect(safeUrl('fi​le:///etc/passwd')).toBe(EMPTY)
  })
})

describe('block: deny-list bypass via long padding (defense-in-depth)', () => {
  test('31-char padding before javascript: — deny-list slice(0,32) misses scheme', () => {
    // 'x'.repeat(31) + 'javascript:...' → head = 'xxx...j' (deny-list sees no match)
    // BUT: URL() parses 'xxxxxxxxxxx...javascript:' as a custom (non-http/https) protocol
    // so the protocol allowlist catches it. Safe, but deny-list was bypassed.
    // POTENTIAL GAP: the deny-list is a first-line guard; for this pattern the second
    // line (protocol allowlist) is the actual defence. The deny-list window (32 chars)
    // could be increased or removed in favour of relying solely on the URL() allowlist.
    const padded = 'x'.repeat(31) + 'javascript:alert(1)'
    expect(safeUrl(padded)).toBe(EMPTY)
  })

  test('32-char padding before javascript: — deny-list definitely misses; URL() still rejects', () => {
    const padded = 'x'.repeat(32) + 'javascript:alert(1)'
    expect(safeUrl(padded)).toBe(EMPTY)
  })
})

// ── BLOCK: relative / ambiguous URLs ──────────────────────────────────────────

describe('block: relative and ambiguous inputs', () => {
  test('relative path /foo — new URL() requires base; throws → empty', () => {
    expect(safeUrl('/foo')).toBe(EMPTY)
  })

  test('protocol-relative //evil.com — new URL() throws without base → empty', () => {
    expect(safeUrl('//evil.com/x')).toBe(EMPTY)
  })

  test('bare word foo', () => {
    expect(safeUrl('foo')).toBe(EMPTY)
  })

  test('fragment-only #frag', () => {
    expect(safeUrl('#frag')).toBe(EMPTY)
  })

  test('whitespace-only string (trim → empty, !url guard)', () => {
    expect(safeUrl('   ')).toBe(EMPTY)
  })

  test('newline-only string', () => {
    expect(safeUrl('\n')).toBe(EMPTY)
  })

  test('null byte only \\x00', () => {
    expect(safeUrl('\x00')).toBe(EMPTY)
  })
})

// ── BLOCK: non-string / edge type inputs ──────────────────────────────────────

describe('block: non-string and falsy inputs (must not throw)', () => {
  test('null — typeof check returns empty', () => {
    expect(safeUrl(null)).toBe(EMPTY)
  })

  test('undefined — typeof check returns empty', () => {
    expect(safeUrl(undefined)).toBe(EMPTY)
  })

  test('empty string — falsy guard returns empty', () => {
    expect(safeUrl('')).toBe(EMPTY)
  })

  test('number 42 — not a string', () => {
    expect(safeUrl(42)).toBe(EMPTY)
  })

  test('number 0 — not a string', () => {
    expect(safeUrl(0)).toBe(EMPTY)
  })

  test('boolean false — not a string', () => {
    expect(safeUrl(false)).toBe(EMPTY)
  })

  test('boolean true — not a string', () => {
    expect(safeUrl(true)).toBe(EMPTY)
  })

  test('plain object {} — not a string', () => {
    expect(safeUrl({})).toBe(EMPTY)
  })

  test('array with valid URL — not a string', () => {
    expect(safeUrl(['https://example.com'])).toBe(EMPTY)
  })
})
