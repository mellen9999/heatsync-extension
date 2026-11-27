/**
 * The vod tab's room (the owner's emote sets) is held for that tab only. The worker used to save
 * every extra join to joined_extra_channels and drop it only when the page said leave, so closing
 * the browser tab or a hard navigation left the room joined for good. Real worker, real handler.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { bootSw, disposeAll, json, status, tabSender } from './harness/sw.js'

afterEach(disposeAll)

const AUTH = { name: 'auth', value: 'tok-abc', domain: 'heatsync.org' }
const VOD = 'https://www.twitch.tv/videos/2934223993'
const vodTab = (id) => tabSender(id, VOD)

async function boot() {
  const sw = await bootSw({
    cookies: [AUTH],
    tabs: [
      { id: 7, url: VOD },
      { id: 8, url: VOD },
    ],
  })
  sw.net.on(/emotes\/user\//, json({ emotes: [] }))
  sw.net.on(/betterttv|frankerfacez|7tv\.io/, status(404))
  sw.net.on(/helix|gql|emotes\/twitch/, json({ emotes: [] }))
  await sw.connect()
  return sw
}
const join = (sw, tab, extra = {}) =>
  sw.send(
    { type: 'ws_send', data: { type: 'channel:join', platform: 'twitch', channel: 'Owner' }, ...extra },
    vodTab(tab),
  )
const leaves = (sw) => sw.socket().frames.filter((f) => f.type === 'channel:leave')
const saved = (sw) => sw.storage.local.snapshot().joined_extra_channels || []

describe('a scoped extra join ends with its tab', () => {
  test('closing the tab leaves the room and it was never saved', async () => {
    const sw = await boot()
    await join(sw, 7, { scoped: true })
    await sw.advance(10)
    expect(sw.eval('[...joinedExtraChannels]')).toEqual(['twitch/owner'])
    expect(saved(sw)).toEqual([])
    sw.removeTab(7)
    expect(sw.eval('[...joinedExtraChannels]')).toEqual([])
    expect(leaves(sw)).toContainEqual({ type: 'channel:leave', platform: 'twitch', channel: 'owner' })
  })

  test('a reload or hard navigation of the tab leaves it too', async () => {
    const sw = await boot()
    await join(sw, 7, { scoped: true })
    sw.navigateTab(7, 'https://www.twitch.tv/somebody')
    expect(sw.eval('[...joinedExtraChannels]')).toEqual([])
    expect(leaves(sw).length).toBe(1)
  })

  test('the page saying leave (in-app navigation) leaves it', async () => {
    const sw = await boot()
    await join(sw, 7, { scoped: true })
    await sw.send(
      { type: 'ws_send', data: { type: 'channel:leave', platform: 'twitch', channel: 'owner' }, scoped: true },
      vodTab(7),
    )
    expect(sw.eval('[...joinedExtraChannels]')).toEqual([])
    expect(leaves(sw).length).toBe(1)
  })

  test('another tab on the same vod keeps the room until it goes too', async () => {
    const sw = await boot()
    await join(sw, 7, { scoped: true })
    await join(sw, 8, { scoped: true })
    sw.removeTab(7)
    expect(sw.eval('[...joinedExtraChannels]')).toEqual(['twitch/owner'])
    expect(leaves(sw)).toEqual([])
    sw.removeTab(8)
    expect(sw.eval('[...joinedExtraChannels]')).toEqual([])
    expect(leaves(sw).length).toBe(1)
  })

  test('a saved tab already holding the room keeps it when the vod tab goes', async () => {
    const sw = await boot()
    await join(sw, 8) // a saved tab's plain join: permanent
    await join(sw, 7, { scoped: true })
    sw.removeTab(7)
    expect(sw.eval('[...joinedExtraChannels]')).toEqual(['twitch/owner'])
    expect(saved(sw)).toEqual(['twitch/owner'])
    expect(leaves(sw)).toEqual([])
  })

  test('a saved tab joining after the vod tab takes the room over', async () => {
    const sw = await boot()
    await join(sw, 7, { scoped: true })
    await join(sw, 8)
    sw.removeTab(7)
    expect(sw.eval('[...joinedExtraChannels]')).toEqual(['twitch/owner'])
    expect(saved(sw)).toEqual(['twitch/owner'])
    expect(leaves(sw)).toEqual([])
  })

  test('a tab whose page is on that channel keeps the room', async () => {
    const sw = await boot()
    sw.eval(`tabChannels.set(8, { channel: 'twitch/owner', channelOwner: null })`)
    await join(sw, 7, { scoped: true })
    sw.removeTab(7)
    expect(leaves(sw)).toEqual([])
  })
})
