import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A live 7TV add or removal is announced, and never rewrites a channel's emote
 * list that is not there to patch.
 *
 * 2026-10-29, nl_kripp: the channel's list was missing in the background (a
 * failed fetch with nothing to fall back on) while its 7TV set stayed
 * subscribed. The removal found nothing to remove and said nothing; the add
 * became the WHOLE list, so the tab rendered that one emote and no other.
 *
 * Runs the real handler, cut out of background.js, against stubbed state.
 */

const BG = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')
const SRC = BG.slice(BG.indexOf('function handle7TVEmoteSetUpdate('), BG.indexOf('// ========== BTTV Live Socket'))

function load(map, setIds) {
  const sent = []
  const refetched = []
  const env = {
    seventvEmoteSetIds: new Map(setIds),
    channelEmotesMap: map,
    channelEmotesFetchedAt: {},
    splitChKey: (k) =>
      k.includes('/') ? { platform: k.split('/')[0], channel: k.split('/')[1] } : { platform: 'twitch', channel: k },
    log: () => {},
    broadcastToTabs: (m) => sent.push(m),
    fetchChannelOwnerEmotes: async (ch, id, platform) => {
      refetched.push(`${platform}/${ch}`)
    },
    getStorableChannelEmotes: () => ({}),
    browser: { storage: { local: { set: async () => {} } } },
  }
  const handle = new Function(...Object.keys(env), `${SRC}; return handle7TVEmoteSetUpdate`)(...Object.values(env))
  return { handle, sent, refetched }
}

const SET = '01FHJ0QDXG0000Z4X2TRBKR5FG'
const A = '01AAAAAAAAAAAAAAAAAAAAAAAA'
const B = '01BBBBBBBBBBBBBBBBBBBBBBBB'
const actor = { display_name: 'mellen' }
const add = { id: SET, actor, pushed: [{ value: { id: A, name: 'ArnoldSmile', data: {} } }] }
const pull = { id: SET, actor, pulled: [{ old_value: { id: B, name: 'VinceArrive' } }] }

describe('7TV live update', () => {
  test('with no list: announces the add, leaves the map alone, refetches', () => {
    const map = {}
    const { handle, sent, refetched } = load(map, [['nl_kripp', SET]])
    handle(add)
    expect(sent.map((m) => m.type)).toEqual(['channel_emote_added'])
    expect(sent[0]).toMatchObject({ channel: 'nl_kripp', message: 'mellen added 7TV emote ArnoldSmile' })
    expect(map.nl_kripp).toBeUndefined()
    expect(refetched).toEqual(['twitch/nl_kripp'])
  })

  test('with no list: announces the removal too', () => {
    const { handle, sent } = load({}, [['nl_kripp', SET]])
    handle(pull)
    expect(sent.map((m) => [m.type, m.emoteName])).toEqual([['channel_emote_removed', 'VinceArrive']])
  })

  test('mid-refetch: announces, keeps the loading sentinel, does not start a second fetch', () => {
    const map = { nl_kripp: 'loading' }
    const { handle, sent, refetched } = load(map, [['nl_kripp', SET]])
    handle(add)
    expect(sent.map((m) => m.type)).toEqual(['channel_emote_added'])
    expect(map.nl_kripp).toBe('loading')
    expect(refetched).toEqual([])
  })

  test('with a list: patches it and sends the whole patched list', () => {
    const map = {
      nl_kripp: [
        { name: 'VinceArrive', hash: B, source: '7tv' },
        { name: 'Kappa', hash: 'k', source: 'twitch' },
      ],
    }
    const { handle, sent } = load(map, [['nl_kripp', SET]])
    handle(pull)
    handle(add)
    expect(map.nl_kripp.map((e) => e.name)).toEqual(['Kappa', 'ArnoldSmile'])
    const full = sent.filter((m) => m.type === 'channel_emotes_update').at(-1)
    expect(full.emotes.map((e) => e.name)).toEqual(['Kappa', 'ArnoldSmile'])
  })

  test('every channel sharing the set hears it, not just the first', () => {
    const { handle, sent } = load({ nl_kripp: [], 'kick/kripp': [] }, [
      ['nl_kripp', SET],
      ['kick/kripp', SET],
    ])
    handle(add)
    expect(sent.filter((m) => m.type === 'channel_emote_added').map((m) => `${m.platform}/${m.channel}`)).toEqual([
      'twitch/nl_kripp',
      'kick/kripp',
    ])
  })
})
