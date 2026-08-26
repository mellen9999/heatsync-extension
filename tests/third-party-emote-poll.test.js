import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * BTTV/FFZ live-update poll — the delivery guarantee where no socket exists.
 * FFZ has no push channel we speak, and the BTTV socket can drop; without this
 * poll a mid-stream FFZ emote add takes up to the 30-min channel TTL to render.
 *
 * Contract pinned here:
 *  - the poll REUSES fetchBTTVChannelEmotes / fetchFFZChannelEmotes (their
 *    sanitizers and 404 negcaches), never a second fetch path,
 *  - BTTV is skipped while its room is joined on a healthy socket (pushes
 *    supersede polling — the exact gate 7TV uses),
 *  - it is tab-gated on SEVENTV_PLATFORM_URLS like the 7TV idle close,
 *  - changes flow through the same channel_emote_added/removed +
 *    channel_emotes_update pipeline as every other emote mutation,
 *  - first tick per channel|source is a silent baseline (no toast spam),
 *  - polling starts from BOTH entry points: channel fetch completion and
 *    SW-restart restore.
 */

const ROOT = join(import.meta.dir, '..')
const BG = readFileSync(join(ROOT, 'chrome', 'background.js'), 'utf8')

describe('bttv/ffz poll', () => {
  const pollBlock = BG.slice(BG.indexOf('async function pollThirdPartyEmotes'))
  const pollBody = pollBlock.slice(0, pollBlock.indexOf('\n}\n'))

  test('reuses the join-time fetchers, no parallel fetch path', () => {
    expect(pollBody).toContain('fetchFFZChannelEmotes(channelName)')
    expect(pollBody).toContain('fetchBTTVChannelEmotes(channelName, ucid, platform)')
    expect(pollBody).not.toContain('fetchWithTimeout(')
  })

  test('bttv poll defers to a healthy joined socket', () => {
    expect(pollBody).toContain('isBttvSocketHealthy() && room && bttvJoinedRooms.has(room)')
  })

  test('tab-gated like the 7tv idle close', () => {
    expect(pollBody).toContain('browser.tabs.query({ url: SEVENTV_PLATFORM_URLS })')
  })

  test('youtube never resolves a UC id inside the poll', () => {
    expect(pollBody).toContain('ytChannelIdCache.get(channelName)')
    expect(pollBody).toContain("if (platform === 'youtube' && !ucid) continue")
  })

  test('diff applies through the shared broadcast pipeline with baseline gate', () => {
    const diffBlock = BG.slice(BG.indexOf('function applyThirdPartyDiff'))
    const diffBody = diffBlock.slice(0, diffBlock.indexOf('\n}\n'))
    expect(diffBody).toContain("type: 'channel_emote_added'")
    expect(diffBody).toContain("type: 'channel_emote_removed'")
    expect(diffBody).toContain("type: 'channel_emotes_update'")
    expect(diffBody).toContain('thirdPartyPolledChannels.has(')
    expect(diffBody).toContain('getStorableChannelEmotes()')
  })

  test('poll starts from both entry points', () => {
    const calls = BG.split('startThirdPartyPolling()').length - 1
    // definition guard + fetch-completion + restore = at least 2 call sites
    expect(calls).toBeGreaterThanOrEqual(3)
  })
})
