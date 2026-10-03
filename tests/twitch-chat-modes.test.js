// Twitch chat modes all go through ONE mutation — updateChatSettings. Schema-
// probed live 2026-07-21: the field exists, its input type is
// UpdateChatSettingsInput!, channelID is a required String!.
//
// The load-bearing fact: twitch's GQL silently ACCEPTS unknown input fields, so
// a typo'd field name returns no error and changes nothing. A blind "didn't
// error ⇒ success" would therefore lie on every mod command. setTwitchChatMode
// reads the mode back and only claims success when the channel really changed.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const API = readFileSync(join(ROOT, 'src', 'multichat', 'twitch-api.js'), 'utf8')
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

const matches = new Function(`${extractFn(API, '_twitchChatModeMatches')}\nreturn _twitchChatModeMatches`)()

describe('read-back comparison', () => {
  // Duration modes report "off" as null, so our off encodings must accept null.
  test('followers off (-1) matches a null read-back', () => {
    expect(matches('followers', -1, null)).toBe(true)
  })
  test('followers "any follower" (0) needs a real 0, not null', () => {
    expect(matches('followers', 0, 0)).toBe(true)
    expect(matches('followers', 0, null)).toBe(false)
  })
  test('followers N minutes must match exactly', () => {
    expect(matches('followers', 30, 30)).toBe(true)
    expect(matches('followers', 30, 10)).toBe(false)
  })
  test('slow off (0) matches null or 0', () => {
    expect(matches('slow', 0, null)).toBe(true)
    expect(matches('slow', 0, 0)).toBe(true)
  })
  test('slow N seconds must match exactly', () => {
    expect(matches('slow', 10, 10)).toBe(true)
    expect(matches('slow', 10, null)).toBe(false)
  })
  test('boolean modes compare truthiness', () => {
    for (const m of ['emoteonly', 'subscribers', 'unique']) {
      expect(matches(m, true, true)).toBe(true)
      expect(matches(m, false, false)).toBe(true)
      expect(matches(m, true, false)).toBe(false)
      // the silent-accept failure mode: asked for on, channel still off
      expect(matches(m, true, null)).toBe(false)
    }
  })
})

describe('mutation shape', () => {
  const fn = extractFn(API, 'setTwitchChatMode')
  test('uses the schema-verified mutation and input type', () => {
    expect(fn).toContain('$input: UpdateChatSettingsInput!')
    expect(fn).toContain('updateChatSettings(input: $input)')
  })
  test('never returns ok without a matching read-back', () => {
    // the only `ok: true` in the function is inside the verification loop
    const okLines = fn.split('\n').filter((l) => l.includes('ok: true'))
    expect(okLines).toHaveLength(1)
    const idx = fn.indexOf('ok: true')
    expect(fn.slice(0, idx)).toContain('_twitchChatModeMatches')
  })
  test('a silent no-op is reported as failure, not success', () => {
    expect(fn).toContain('twitch did not apply it')
  })
  test('resolve failures keep the transient distinction', () => {
    expect(fn).toContain('twitch unreachable — try again')
  })
  test('only the proven duration modes are writable on twitch', () => {
    const src = API.slice(
      API.indexOf('const TWITCH_CHAT_MODE_SPEC'),
      API.indexOf('\n}', API.indexOf('const TWITCH_CHAT_MODE_SPEC')) + 2,
    )
    const map = new Function(`${src}\nreturn TWITCH_CHAT_MODE_SPEC`)()
    expect(Object.keys(map).sort()).toEqual(['emoteonly', 'followers', 'slow', 'subscribers', 'unique'])
    // proven live
    expect(map.slow.write).toBe('slowModeDurationSeconds')
    expect(map.followers.write).toBe('followersOnlyDurationMinutes')
    // deliberately not wired — twitch changed nothing for either spelling and
    // its own UI no longer exposes these, so we refuse instead of pretending
    for (const m of ['emoteonly', 'subscribers', 'unique']) {
      expect(map[m].write, m).toBeNull()
      expect(map[m].read, m).toBeTruthy() // still readable for /status
    }
  })

  test('an unsupported mode refuses up front and never mutates', () => {
    const fn = extractFn(API, 'setTwitchChatMode')
    expect(fn).toContain('if (!spec.write) return { ok: false, unsupported: true')
    // the refusal must come before the mutation call
    expect(fn.indexOf('!spec.write')).toBeLessThan(fn.indexOf('gqlMutation'))
  })

  test('kick success wins over a twitch refusal', () => {
    expect(INPUT).toContain('resp?.unsupported && kickResp?.ok')
    expect(INPUT).toContain("showToast(t('mc_cm_link'), 'error')")
  })

  test('confirmation reads the read-type field, not a write field', () => {
    expect(extractFn(API, 'setTwitchChatMode')).toContain('after[spec.read]')
  })
  test('the followers wrapper still exists for its old callers', () => {
    expect(API).toContain('async function setTwitchFollowersMode(channelLogin, minutes)')
  })
})

describe('composer wiring', () => {
  test('the "not wired" stub is gone', () => {
    expect(INPUT).not.toContain('mc_input_mode_not_wired')
  })
  test('every mode routes through setTwitchChatMode', () => {
    expect(INPUT).toContain('setTwitchChatMode(twitchTarget, cmd, value)')
  })
  test('copy keys exist in the default locale', () => {
    for (const k of [
      'mc_input_mode_on',
      'mc_input_mode_off',
      'mc_input_mode_on_dur',
      'mc_input_mode_failed',
      'mc_input_usage_mode',
    ]) {
      expect(EN[k]?.message, k).toBeTruthy()
    }
  })
})

// ─── Kick side ──────────────────────────────────────────────────────────────
// All of this was proven against the live API 2026-07-21, and the first two
// guesses were wrong:
//   · body is FLAT BOOLEANS. The nested shape the GET returns 422s with
//     "This field must be true or false [slow mode]."
//   · GET /api/v2/channels/<slug>/chatroom is CACHED — it reported enabled:false
//     while the row was already true, so it cannot confirm anything. The PUT's
//     own response row is the oracle.
//   · the slow interval is not settable through this route under any field name
//     tried, so the verifier must not assert on it.
describe('kick chat modes', () => {
  const KICK = readFileSync(join(ROOT, 'src', 'multichat', 'kick-send.js'), 'utf8')
  const api = new Function(`
    ${KICK.slice(KICK.indexOf('const KICK_CHAT_MODE_KEYS'), KICK.indexOf('async function setKickChatMode'))}
    return { kickChatModeBody, kickChatModeMatches }
  `)()

  test('slow on is a flat boolean (nested shape is what kick 422s)', () => {
    const b = api.kickChatModeBody('slow', 5)
    expect(b.slow_mode).toBe(true)
    expect(typeof b.slow_mode).toBe('boolean')
  })
  test('slow off disables', () => {
    expect(api.kickChatModeBody('slow', 0).slow_mode).toBe(false)
  })
  test('followers off maps twitch -1 onto false', () => {
    expect(api.kickChatModeBody('followers', -1)).toEqual({ followers_mode: false })
  })
  test('followers 0 is ON with no age gate, not off', () => {
    expect(api.kickChatModeBody('followers', 0)).toEqual({ followers_mode: true })
  })
  test('boolean modes', () => {
    expect(api.kickChatModeBody('emoteonly', true)).toEqual({ emotes_mode: true })
    expect(api.kickChatModeBody('subscribers', false)).toEqual({ subscribers_mode: false })
  })
  test('unique-chat has no kick equivalent', () => {
    expect(api.kickChatModeBody('unique', true)).toBeNull()
  })

  // Rows below are shaped exactly like the live PUT response.
  const ROW_ON = {
    id: 84407,
    slow_mode: true,
    message_interval: 0,
    followers_mode: false,
    subscribers_mode: false,
    emotes_mode: false,
  }
  const ROW_OFF = { ...ROW_ON, slow_mode: false }

  test('confirms against the PUT response row', () => {
    expect(api.kickChatModeMatches('slow', 5, ROW_ON)).toBe(true)
    expect(api.kickChatModeMatches('slow', 0, ROW_ON)).toBe(false)
    expect(api.kickChatModeMatches('slow', 0, ROW_OFF)).toBe(true)
    expect(api.kickChatModeMatches('emoteonly', false, ROW_OFF)).toBe(true)
    expect(api.kickChatModeMatches('emoteonly', true, ROW_OFF)).toBe(false)
  })
  // kick ignores the interval; asserting it would fail every /slow that worked.
  test('does not assert on message_interval', () => {
    expect(api.kickChatModeMatches('slow', 30, ROW_ON)).toBe(true)
  })
  test('a row missing the key never counts as a match', () => {
    expect(api.kickChatModeMatches('slow', 0, {})).toBe(false)
    expect(api.kickChatModeMatches('slow', 0, null)).toBe(false)
  })
  test('setKickChatMode confirms against resp.row, not a second read', () => {
    const fn = KICK.slice(KICK.indexOf('async function setKickChatMode'))
    expect(fn).toContain('kickChatModeMatches(mode, value, resp.row)')
    expect(fn).toContain('kick did not apply it')
  })
  test('the relay hands the row back', () => {
    const C = readFileSync(join(ROOT, 'chrome', 'content.js'), 'utf8')
    expect(C).toContain('sendResponse({ ok: true, row })')
  })
  test('composer refuses unique-chat on a kick-only channel instead of no-oping', () => {
    expect(INPUT).toContain('mc_input_mode_kick_unsupported')
  })
})
