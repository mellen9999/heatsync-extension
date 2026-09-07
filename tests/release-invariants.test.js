// Structural invariants for three things rewritten on 2026-07-21 that are
// individually correct but quietly break if someone edits them without the
// context. Each of these was reasoned through by hand before release; this
// file is that reasoning made automatic.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const API = readFileSync(join(ROOT, 'src', 'multichat', 'twitch-api.js'), 'utf8')
const EMOTES = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')
const SEND = readFileSync(join(ROOT, 'src', 'multichat', 'kick-send.js'), 'utf8')
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')

describe('resolveTwitchChannelId: two shapes, never confused', () => {
  // The bare wrapper returns a STRING id; the Ex version returns {id,transient}.
  // Destructuring the bare one yields undefined and silently disables a mod verb.
  test('nobody destructures the bare wrapper', () => {
    for (const src of [API, INPUT]) {
      const bad = [...src.matchAll(/\{[^}]*\}\s*=\s*await\s+resolveTwitchChannelId\(/g)]
      expect(bad.map((m) => m[0])).toEqual([])
    }
  })
  test('every mod verb uses the transient-aware version', () => {
    for (const fn of [
      'banTwitchUser',
      'timeoutTwitchUser',
      'unbanTwitchUser',
      'announceTwitchChat',
      'deleteTwitchMessage',
    ]) {
      const start = API.indexOf(`function ${fn}(`)
      const body = API.slice(start, API.indexOf('\n}', start))
      expect(body, fn).toContain('resolveTwitchChannelIdEx(')
    }
  })
})

describe('emote block rollback cannot recurse', () => {
  // syncBlockToAPI rolls back by calling the OPPOSITE op. If that call ever
  // omits skipSync it re-enters syncBlockToAPI → infinite ping-pong of server
  // writes. Both rollback calls must carry skipSync.
  const fn = EMOTES.slice(
    EMOTES.indexOf('async function syncBlockToAPI'),
    EMOTES.indexOf('\n}', EMOTES.indexOf('async function syncBlockToAPI')),
  )
  test('both rollback calls pass skipSync', () => {
    const calls = [...fn.matchAll(/(?:un)?blockEmote\((?:emoteName)[^)]*\)/g)].map((m) => m[0])
    expect(calls.length).toBe(2)
    for (const c of calls) expect(c, c).toContain('skipSync: true')
  })
  test('rollbacks are silent so the failure toasts exactly once', () => {
    const calls = [...fn.matchAll(/(?:un)?blockEmote\((?:emoteName)[^)]*\)/g)].map((m) => m[0])
    for (const c of calls) expect(c, c).toContain('silent: true')
  })
  test('block/unblock only toast success when there is no sync coming', () => {
    for (const name of ['blockEmote', 'unblockEmote']) {
      const start = EMOTES.indexOf(`function ${name}(`)
      const body = EMOTES.slice(start, EMOTES.indexOf('\nfunction ', start + 10))
      const toastLine = body
        .split('\n')
        .find((l) => /showToast\(t\((?:block \? )?'mc_emote_(blocked_toast|unblocked)'/.test(l))
      expect(toastLine, name).toBeTruthy()
      expect(toastLine, name).toContain('skipSync')
    }
  })
})

describe('kick send retry loop is bounded', () => {
  const fn = SEND.slice(SEND.indexOf('async function sendKickMessage'))
  // Two branches do `attempt--` to avoid burning a retry slot. Each must be
  // guarded by a condition it then makes false, or the loop never ends.
  test('every attempt-- is paired with a self-clearing guard', () => {
    const decrements = (fn.match(/attempt--/g) || []).length
    expect(decrements).toBe(2)
    // reply branch: guarded on replyRef, which it nulls
    expect(fn).toMatch(/if \(replyRef && [^)]*\)/)
    expect(fn).toContain('replyRef = null')
    // emote branch: guarded on body still containing a token, which it strips.
    // Checked via the relay's machine-readable `code` field (chrome/content.js
    // kickSendErrorCode), not by matching kick's raw error text.
    expect(fn).toMatch(/code === 'invalid_emote'[\s\S]{0,120}body\s*=/)
  })
  test('the emote fallback checks the body it is about to rewrite', () => {
    const branch = fn.slice(fn.indexOf(`code === 'invalid_emote'`))
    expect(branch.slice(0, 200)).toContain('body')
  })
})
