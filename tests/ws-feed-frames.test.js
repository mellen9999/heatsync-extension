import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { bgSource } from './bg-src.js'

const rd = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const BG = bgSource()
const SOCIAL = rd('src/multichat/social.js')
const WHISPERS = rd('src/multichat/whispers.js')
const cut = (src, a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)))

describe('feed + dm frames', () => {
  test('background handles each frame', () => {
    expect(BG).toContain("case 'message:hidden'")
    expect(BG).toContain("case 'heat:updated'")
    expect(BG).toContain("case 'dm:message-deleted'")
  })

  test('a hidden post ends like a deleted one', () => {
    const body = cut(BG, "case 'message:hidden'", "case 'heat:updated'")
    expect(body).toContain("type: 'message-deleted'")
    expect(body).toContain('message_id: msg.data.id')
  })

  test('heat lands on every cached copy; junk is ignored', () => {
    const src = `${cut(SOCIAL, 'function feedApplyHeat(', '// heat can move many')}
let activeThread = null
const feedMessages = [{ base36_id: 'a', heat: 1 }, { base36_id: 'b', heat: 1 }]
function feedCachedCopies(id) { return feedMessages.filter((m) => m.base36_id === id) }
return { feedApplyHeat, feedMessages }`
    const { feedApplyHeat, feedMessages } = new Function(src)()
    expect(feedApplyHeat({ messageId: 'a', newHeat: 42, newMaxHeat: 50 })).toBe(true)
    expect(feedMessages[0]).toMatchObject({ heat: 42, max_heat: 50 })
    expect(feedMessages[1].heat).toBe(1)
    expect(feedApplyHeat({ messageId: 'a', newHeat: '<img>' })).toBe(false)
    expect(feedApplyHeat({ messageId: 'zzz', newHeat: 5 })).toBe(false)
  })

  test('heat is a feed-gated event and repaints are debounced', () => {
    expect(cut(SOCIAL, 'const _FEED_EVENTS', ']).')).toContain("'heat-updated'")
    expect(SOCIAL).toContain('if (_feedHeatTimer) return')
  })

  test('a deleted dm leaves the timeline, heatsync dms only', () => {
    const src = `${cut(WHISPERS, 'function dropDmFromTimeline(', 'function handleIncomingDm(')}
const whisperTimeline = [
  { platform: 'heatsync', id: '7' }, { platform: 'twitch', id: '7' }, { platform: 'heatsync', id: '8' }]
let currentTab = 'feed'
function renderWhispersTab() {}
return { dropDmFromTimeline, whisperTimeline }`
    const { dropDmFromTimeline, whisperTimeline } = new Function(src)()
    expect(dropDmFromTimeline('7')).toBe(1)
    expect(whisperTimeline.map((w) => `${w.platform}:${w.id}`)).toEqual(['twitch:7', 'heatsync:8'])
    expect(dropDmFromTimeline('')).toBe(0)
  })
})
