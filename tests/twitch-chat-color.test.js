import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// /color goes through twitch's GQL, which accepts input it does not understand —
// so "no error" is never proof. Success is only claimed after reading
// user.chatColor back and seeing the color we asked for.
const SRC = readFileSync(new URL('../src/multichat/twitch-api.js', import.meta.url), 'utf8')
const a = SRC.indexOf('const TWITCH_NAMED_COLORS')
const b = SRC.indexOf('// Back-compat wrapper')
const BODY = SRC.slice(a, b)

// twitch: what the account's chatColor reads as after each mutation attempt
function rig({ applies }) {
  const sent = []
  let color = ''
  const gqlMutation = async (_q, v) => {
    sent.push(v.input.color)
    if (applies(v.input.color)) color = v.input.color.startsWith('#') ? v.input.color : NAMES[v.input.color]
    return { data: {} }
  }
  const twitchGql = async () => ({ data: { user: { chatColor: color || null } } })
  const NAMES = { OrangeRed: '#FF4500', Red: '#FF0000' }
  const fn = new Function('gqlMutation', 'twitchGql', `${BODY}; return setTwitchChatColor`)(gqlMutation, twitchGql)
  return { fn, sent }
}

describe('setTwitchChatColor', () => {
  test('a name is sent as twitch spells it, and confirmed by reading it back', async () => {
    const { fn, sent } = rig({ applies: () => true })
    expect(await fn('  OrangeRed ', 'me')).toEqual({ ok: true, hex: '#FF4500' })
    expect(sent).toEqual(['OrangeRed'])
  })

  test('case and spacing in the name do not matter', async () => {
    const { fn } = rig({ applies: () => true })
    expect((await fn('orange red', 'me')).hex).toBe('#FF4500')
  })

  test('an unknown color never reaches twitch', async () => {
    const { fn, sent } = rig({ applies: () => true })
    const res = await fn('chartreuse', 'me')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown color')
    expect(sent).toEqual([])
  })

  test('twitch ignoring the name is retried as hex, then reported honestly', async () => {
    const { fn, sent } = rig({ applies: () => false })
    const res = await fn('red', 'me')
    expect(res.ok).toBe(false)
    expect(sent).toEqual(['Red', '#FF0000'])
  })

  test('a hex that twitch does not take points at turbo', async () => {
    const { fn } = rig({ applies: () => false })
    const res = await fn('#ff8700', 'me')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('turbo')
  })

  test('no login, no call', async () => {
    const { fn, sent } = rig({ applies: () => true })
    expect((await fn('red', '')).ok).toBe(false)
    expect(sent).toEqual([])
  })
})
