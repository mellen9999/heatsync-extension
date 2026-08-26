import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * BTTV Live Socket — the extension joins sockets.betterttv.net rooms so BTTV
 * channel emote add/remove/rename land mid-session, the same UX the 7TV
 * EventAPI already provides. Without the socket a BTTV change only appears
 * after the channel-emote TTL refetch.
 *
 * The wiring has four legs that must not drift independently:
 *   1. room registration inside fetchBTTVChannelEmotes (both twitch + youtube
 *      branches — the only places the provider id is known),
 *   2. eviction parity with seventvEmoteSetIds (a channel evicted from
 *      channelEmotesMap must also part its BTTV room),
 *   3. SW-restart restore (bttv_room_ids mirrors seventv_emote_set_ids),
 *   4. manifest CSP: the SW cannot open wss://sockets.betterttv.net unless
 *      connect-src lists it — in BOTH manifests.
 */

const ROOT = join(import.meta.dir, '..')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')
const MANIFEST_CHROME = readFileSync(join(ROOT, 'src', 'manifests', 'chrome.json'), 'utf8')
const MANIFEST_FIREFOX = readFileSync(join(ROOT, 'src', 'manifests', 'firefox.json'), 'utf8')

describe('bttv live socket', () => {
  test('socket connects to the real BTTV endpoint', () => {
    expect(BG).toContain("new WebSocket('wss://sockets.betterttv.net/ws')")
  })

  test('both fetch branches register their room (twitch + youtube)', () => {
    expect(BG).toContain("subscribeBTTVChannel(chKey('twitch', channelName), `twitch:${twitchId}`)")
    expect(BG).toContain("subscribeBTTVChannel(chKey('youtube', channelName), `youtube:${channelId}`)")
  })

  test('join/part use the documented protocol frames', () => {
    expect(BG).toContain("name: 'join_channel'")
    expect(BG).toContain("name: 'part_channel'")
  })

  test('all three emote events are handled and validated', () => {
    for (const ev of ['emote_create', 'emote_delete', 'emote_update']) {
      expect(BG).toContain(`'${ev}'`)
    }
    // emote_create must gate on BTTV's 24-hex id before touching the cache
    expect(BG).toContain('/^[a-f0-9]{24}$/i.test(e.id)')
  })

  test('eviction parts the BTTV room alongside the 7TV set release', () => {
    const evictionBlock = BG.slice(BG.indexOf('release7TVEmoteSet(evictedSetId)'))
    const firstChunk = evictionBlock.slice(0, 600)
    expect(firstChunk).toContain('bttvRoomIds.delete(old)')
    expect(firstChunk).toContain('partBTTVRoom(evictedRoom)')
  })

  test('SW restart restores rooms and reconnects (mirrors seventv_emote_set_ids)', () => {
    expect(BG).toContain('stored.bttv_room_ids')
    const restore = BG.slice(BG.indexOf('stored.bttv_room_ids'))
    expect(restore.slice(0, 600)).toContain('connectBTTVSocket()')
  })

  test('updates propagate through the same channel_emotes_update pipeline as 7TV', () => {
    const handler = BG.slice(BG.indexOf('function handleBTTVSocketEvent'))
    const body = handler.slice(0, handler.indexOf('\n}\n'))
    expect(body).toContain("type: 'channel_emote_added'")
    expect(body).toContain("type: 'channel_emote_removed'")
    expect(body).toContain("type: 'channel_emotes_update'")
    expect(body).toContain('getStorableChannelEmotes()')
  })

  test('CSP connect-src allows the socket in BOTH manifests', () => {
    expect(MANIFEST_CHROME).toContain('wss://sockets.betterttv.net')
    expect(MANIFEST_FIREFOX).toContain('wss://sockets.betterttv.net')
  })
})
