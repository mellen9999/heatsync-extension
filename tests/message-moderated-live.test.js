// message:approved / message:flagged — the media scan settled on a post.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const ROOT = join(import.meta.dir, '..')
const BG = bgSource()
const SOCIAL = readFileSync(join(ROOT, 'src', 'multichat', 'social.js'), 'utf8')
const ENGAGE = readFileSync(join(ROOT, 'src', 'multichat', 'feed-engage.js'), 'utf8')
const fn = (code, name) => {
  const a = code.indexOf(`function ${name}(`)
  if (a < 0) throw new Error(`${name} not found`)
  return code.slice(a, code.indexOf('\n}', a) + 2)
}
const frame = new Function(`${fn(BG, 'moderationFrame')}; return moderationFrame`)()
const rig = (copies) =>
  new Function('feedCachedCopies', `${fn(ENGAGE, 'feedApplyModeration')}; return feedApplyModeration`)(() => copies)

describe('moderationFrame', () => {
  test('approved and flagged, nested or flat', () => {
    expect(frame({ type: 'message:approved', data: { id: '4a' } })).toEqual({
      id: '4a',
      categories: [],
      flagged: false,
    })
    expect(frame({ type: 'message:flagged', data: { id: '4a', categories: ['nsfw', 5] } })).toEqual({
      id: '4a',
      categories: ['nsfw'],
      flagged: true,
    })
    expect(frame({ type: 'message:approved', id: '4a' }).id).toBe('4a')
  })
  test('junk ids and shapes are null; categories are bounded', () => {
    for (const bad of [
      null,
      {},
      { data: {} },
      { data: { id: 'a b' } },
      { data: { id: 5 } },
      { data: { id: 'x'.repeat(13) } },
    ]) {
      expect(frame(bad)).toBeNull()
    }
    const big = frame({ type: 'message:flagged', data: { id: 'a', categories: Array(50).fill('y'.repeat(99)) } })
    expect(big.categories).toHaveLength(20)
    expect(big.categories[0]).toHaveLength(40)
  })
})

describe('feedApplyModeration', () => {
  test('a pending copy stops scanning; flagged categories land where the held-media toggles read them', () => {
    const a = { moderation_pending: true }
    const b = { moderation_pending: true }
    expect(rig([a, b])({ id: 'x', categories: ['nsfw'], flagged: true })).toBe(2)
    expect(a).toEqual({ moderation_result: { action: 'review', isFlagged: true, flaggedCategories: ['nsfw'] } })
  })
  test('approved clears pending with a clean result', () => {
    const a = { moderation_pending: true }
    rig([a])({ id: 'x', categories: [], flagged: false })
    expect(a.moderation_result).toEqual({ action: 'approve', isFlagged: false, flaggedCategories: [] })
    expect(a.moderation_pending).toBeUndefined()
  })
  test('a post that was not pending, or already has a richer result, is left alone', () => {
    const settled = { moderation_result: { action: 'approve' } }
    expect(rig([settled])({ id: 'x', flagged: true, categories: ['nsfw'] })).toBe(0)
    expect(settled.moderation_result.action).toBe('approve')
    const rich = { moderation_pending: true, moderation_result: { action: 'review', flaggedCategories: ['gore'] } }
    rig([rich])({ id: 'x', flagged: false, categories: [] })
    expect(rich.moderation_result.flaggedCategories).toEqual(['gore'])
    expect(rich.moderation_pending).toBeUndefined()
  })
  test('wired: background forwards, the feed gate owns the event, the open feed repaints', () => {
    expect(BG).toMatch(/case 'message:approved':\s*\n\s*case 'message:flagged': \{[\s\S]*type: 'message_moderated'/)
    expect(SOCIAL).toMatch(/_FEED_EVENTS = new Set\(\[[^\]]*'message_moderated'/)
    expect(SOCIAL).toMatch(/feedApplyModeration\(msg\.data\) && currentTab === 'feed'\) feedHeatRepaintSoon\(\)/)
  })
})
