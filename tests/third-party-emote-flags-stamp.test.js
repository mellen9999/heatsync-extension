/**
 * A channel's 7tv/bttv/ffz sets come straight from the providers, so they know
 * nothing of heatsync's own scan. The background stamps the site's per-emote
 * `cw_cats` on by (provider, name) so the render gate can hide the category the
 * viewer turned off — and a failed lookup must cost a channel nothing.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../chrome/background.js', import.meta.url), 'utf8')
const start = SRC.indexOf('async function stampThirdPartyFlags(')
if (start === -1) throw new Error('stampThirdPartyFlags not found — source drifted, update this test')
const body = SRC.slice(start, SRC.indexOf('\n}', start) + 2)

function load(fetchWithTimeout) {
  const logs = []
  const make = new Function('API_URL', 'fetchWithTimeout', 'log', `${body}\nreturn stampThirdPartyFlags`)
  return { stamp: make('https://heatsync.org', fetchWithTimeout, (...a) => logs.push(a.join(' '))), logs }
}

const answer = (emotes) => async () => ({ ok: true, json: async () => ({ emotes }) })

describe('stampThirdPartyFlags', () => {
  test('stamps the scanner categories onto the matching provider emote', async () => {
    const { stamp } = load(answer([{ name: 'pissChilling', provider: '7tv', cw_cats: ['weapons'] }]))
    const emotes = [
      { name: 'pissChilling', source: '7tv' },
      { name: 'KEKW', source: '7tv' },
    ]
    await stamp(emotes, 'somechannel', 'twitch')
    expect(emotes[0].cw_cats).toEqual(['weapons'])
    expect(emotes[1].cw_cats).toBeUndefined()
  })

  test('the same name from another provider is a different emote', async () => {
    const { stamp } = load(answer([{ name: 'Gun', provider: 'bttv', cw_cats: ['weapons'] }]))
    const emotes = [{ name: 'Gun', source: '7tv' }]
    await stamp(emotes, 'c', 'twitch')
    expect(emotes[0].cw_cats).toBeUndefined()
  })

  test('kick asks with its own platform, so it never previews a twitch namesake', async () => {
    let asked = ''
    const { stamp } = load(async (url) => {
      asked = url
      return { ok: true, json: async () => ({ emotes: [] }) }
    })
    await stamp([], 'slug', 'kick')
    expect(asked).toContain('/api/channel/slug/emotes?platform=kick')
  })

  test('youtube has no third-party sets: no request at all', async () => {
    let called = false
    const { stamp } = load(async () => {
      called = true
      return { ok: true, json: async () => ({}) }
    })
    await stamp([{ name: 'a', source: '7tv' }], 'UCabc', 'youtube')
    expect(called).toBe(false)
  })

  test('a failed lookup leaves the sets exactly as the providers sent them', async () => {
    for (const f of [
      async () => {
        throw new Error('offline')
      },
      async () => ({ ok: false, status: 500 }),
    ]) {
      const { stamp } = load(f)
      const emotes = [{ name: 'a', source: '7tv' }]
      await stamp(emotes, 'c', 'twitch')
      expect(emotes).toEqual([{ name: 'a', source: '7tv' }])
    }
  })
})
