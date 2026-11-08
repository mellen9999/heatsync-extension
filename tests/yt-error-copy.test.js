// YouTube mod failures reached the toast as raw machine codes — a moderator
// read "delete failed: message_not_found". Send already had an honest code→copy
// map; moderation had one case (not_moderator) and nothing else. These guard
// that every code the yt relay can emit has copy, and that the copy exists in
// the default locale (chrome falls other locales back to en, so en is the one
// that must be complete).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const TARGETS = readFileSync(join(ROOT, 'src', 'multichat', 'send-targets.js'), 'utf8')
const YTC = readFileSync(join(ROOT, 'src', 'content', 'youtube-content.js'), 'utf8')
// src/_locales is the source of truth — build.js copies it over chrome/_locales
// and dist/*/_locales. Asserting against the copy would have passed while the
// real strings were missing (it did, once).
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

const mapper = new Function(
  't',
  `${TARGETS.slice(TARGETS.indexOf('function youtubeModErrorMessage'), TARGETS.indexOf('\n}', TARGETS.indexOf('function youtubeModErrorMessage')) + 2)}
   return youtubeModErrorMessage`,
)((k) => `T:${k}`)

// Every error code handleYtModAction can return, read off the source so a new
// one added there fails this test instead of shipping raw to a moderator.
const CODES = [...new Set([...YTC.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]))]
const THROWN = [...new Set([...YTC.matchAll(/throw new Error\('([a-z_]+)'\)/g)].map((m) => m[1]))]

describe('youtubeModErrorMessage', () => {
  test('the relay actually emits codes (guard against the regex silently matching nothing)', () => {
    expect(CODES.length).toBeGreaterThan(3)
  })

  test('every mod code maps to copy, never to itself', () => {
    const modCodes = [
      'not_moderator',
      'message_not_found',
      'no_context_menu',
      'action_unmapped',
      'yt_rejected',
      'not_signed_in',
      'no_message',
    ]
    for (const c of modCodes) {
      expect(mapper(c)).toStartWith('T:')
    }
  })

  test('the mapped keys all exist in the default locale', () => {
    const keys = [...TARGETS.matchAll(/t\('(mc_yt_mod_[a-z_]+)'\)/g)].map((m) => m[1])
    expect(keys.length).toBe(7)
    for (const k of keys) expect(EN[k]?.message, k).toBeTruthy()
  })

  test('an unknown code passes through rather than flattening to one sentence', () => {
    expect(mapper('some_future_code')).toBe('some_future_code')
  })

  test('no code means unknown', () => {
    expect(mapper('')).toBe('T:mc_common_unknown')
  })

  test('codes thrown by the auth path are covered too', () => {
    expect(THROWN).toContain('not_signed_in')
    expect(mapper('not_signed_in')).toBe('T:mc_yt_mod_not_signed_in')
  })
})

describe('the yt mirror-send leg reports the real reason', () => {
  const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
  test('all three yt send failure sites use the same mapper', () => {
    expect([...INPUT.matchAll(/showToast\(youtubeSendErrorMessage\(result\)/g)].length).toBe(3)
  })
})
