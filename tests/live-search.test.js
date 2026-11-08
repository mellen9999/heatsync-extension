import { expect, test } from 'bun:test'
import { buildLiveSearchMatcher } from '../src/multichat/live-search.js'

function msg(user, text) {
  return { user, text }
}

// ── empty / wildcard ──────────────────────────────────────────────────────────

test('empty query: matches everything', () => {
  const m = buildLiveSearchMatcher('')
  expect(m.test(msg('alice', 'hello world'))).toBe(true)
  expect(m.test(msg('', ''))).toBe(true)
})

// ── plain text substring ──────────────────────────────────────────────────────

test('plain text: matches message body', () => {
  const m = buildLiveSearchMatcher('hello')
  expect(m.test(msg('user', 'hello world'))).toBe(true)
  expect(m.test(msg('user', 'bye'))).toBe(false)
})

test('plain text: matches username', () => {
  const m = buildLiveSearchMatcher('alice')
  expect(m.test(msg('alice', 'bye'))).toBe(true)
  expect(m.test(msg('bob', 'no alice here'))).toBe(true) // body contains it
})

test('plain text: case-insensitive', () => {
  const m = buildLiveSearchMatcher('HELLO')
  expect(m.test(msg('user', 'hello world'))).toBe(true)
})

// ── @user prefix ──────────────────────────────────────────────────────────────

test('@name: matches user by prefix', () => {
  const m = buildLiveSearchMatcher('@alice')
  expect(m.test(msg('alice', 'hi'))).toBe(true)
  expect(m.test(msg('alice2', 'hi'))).toBe(true)
})

test('@name: rejects different user', () => {
  const m = buildLiveSearchMatcher('@alice')
  expect(m.test(msg('bob', 'hi'))).toBe(false)
})

test('@name: does not match body containing the name', () => {
  const m = buildLiveSearchMatcher('@alice')
  expect(m.test(msg('bob', 'alice says hi'))).toBe(false)
})

test('@name: case-insensitive prefix match', () => {
  const m = buildLiveSearchMatcher('@Alice')
  expect(m.test(msg('alice', 'hi'))).toBe(true)
})

// ── /regex/ mode ──────────────────────────────────────────────────────────────

test('/regex/: anchored match on body', () => {
  const m = buildLiveSearchMatcher('/^!/')
  expect(m.test(msg('user', '!command'))).toBe(true)
  expect(m.test(msg('user', 'normal message'))).toBe(false)
})

test('/regex/i: case-insensitive flag', () => {
  const m = buildLiveSearchMatcher('/HELLO/i')
  expect(m.test(msg('user', 'hello world'))).toBe(true)
  expect(m.test(msg('user', 'bye'))).toBe(false)
})

test('/regex/: matches username too', () => {
  const m = buildLiveSearchMatcher('/^ali/')
  expect(m.test(msg('alice', 'bye'))).toBe(true)
  expect(m.test(msg('bob', 'bye'))).toBe(false)
})

test('/regex/: no flag = case-sensitive', () => {
  const m = buildLiveSearchMatcher('/HELLO/')
  expect(m.test(msg('user', 'hello world'))).toBe(false)
  expect(m.test(msg('user', 'HELLO world'))).toBe(true)
})

// ── ReDoS guard ───────────────────────────────────────────────────────────────

test('catastrophic (a+)+ pattern: does not hang, falls back to literal', () => {
  const m = buildLiveSearchMatcher('/(a+)+/')
  const start = Date.now()
  // If the real regex ran, this would hang for seconds on a long mismatching string
  m.test(msg('user', `${'a'.repeat(30)}b`))
  expect(Date.now() - start).toBeLessThan(100)
  // Literal fallback: "(a+)+" must appear verbatim to match
  expect(m.test(msg('user', '(a+)+'))).toBe(true)
  expect(m.test(msg('user', 'aaaaab'))).toBe(false)
})

test('catastrophic (a|a)+ pattern: does not hang', () => {
  const m = buildLiveSearchMatcher('/(a|a)+/')
  const start = Date.now()
  m.test(msg('user', `${'a'.repeat(30)}b`))
  expect(Date.now() - start).toBeLessThan(100)
})

// ── Invalid regex ─────────────────────────────────────────────────────────────

test('invalid /[/ regex: falls back to literal without throwing', () => {
  const m = buildLiveSearchMatcher('/[/')
  expect(() => m.test(msg('user', 'test'))).not.toThrow()
  // Literal fallback matches the verbatim slice between slashes: "["
  expect(m.test(msg('user', 'a [ bracket'))).toBe(true)
  expect(m.test(msg('user', 'no bracket here'))).toBe(false)
})

test('invalid /(?P<x>)/ regex: falls back without throwing', () => {
  const m = buildLiveSearchMatcher('/(?P<x>)/')
  expect(() => m.test(msg('user', 'anything'))).not.toThrow()
})
