/**
 * Live websocket pushes that used to need a reload: block/unblock, settings
 * delete, seen/notification counts, bookmarks, whispers, plus. The frame
 * validators in background.js are pure, so they run for real (extracted from the
 * shipped source); the handler wiring is checked on the source text and the
 * content-side appliers run with stubbed globals.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const ROOT = join(import.meta.dir, '..')
const BG = bgSource()
const src = (f) => readFileSync(join(ROOT, 'src', 'multichat', f), 'utf8')

function extractFn(code, name) {
  const start = code.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found — source drifted`)
  const end = code.indexOf('\n}', start)
  return code.slice(start, end + 2)
}

const bg = new Function(
  `${['blockFrameId', 'unreadFromFrame', 'bookmarkFrame', 'settingsDeleteKey', 'shapeWhisperFrame'].map((n) => extractFn(BG, n)).join('\n')}
return { blockFrameId, unreadFromFrame, bookmarkFrame, settingsDeleteKey, shapeWhisperFrame }`,
)()

describe('user:blocked / user:unblocked', () => {
  test('frame id accepts strings and safe ints, rejects junk', () => {
    expect(bg.blockFrameId({ blocked_user_id: 'abc-123' })).toBe('abc-123')
    expect(bg.blockFrameId({ blocked_user_id: 42 })).toBe('42')
    for (const bad of [
      null,
      {},
      { blocked_user_id: '' },
      { blocked_user_id: 'a b' },
      { blocked_user_id: {} },
      { blocked_user_id: 'x'.repeat(65) },
    ]) {
      expect(bg.blockFrameId(bad)).toBe('')
    }
  })
  test('the server list teaches the id -> key map the unblock uses', () => {
    expect(BG).toMatch(/if \(entry\.id != null\) blockedIdToKey\.set\(String\(entry\.id\), key\)/)
  })
  test('wired: block re-reads the list, unblock drops the learned key and tells tabs', () => {
    expect(BG).toMatch(/case 'user:blocked':\s*\n\s*if \(blockFrameId\(msg\)\) fetchServerBlocks\(true\)/)
    expect(BG).toMatch(
      /case 'user:unblocked': \{[\s\S]*blockedIdToKey\.get\(id\)[\s\S]*persistBlockedUsers\(\)[\s\S]*type: 'user_unblocked'/,
    )
  })
})

describe('settings:delete', () => {
  test('a string key within the sanitizer bound', () => {
    expect(bg.settingsDeleteKey({ key: 'theme' })).toBe('theme')
    for (const bad of [{}, { key: '' }, { key: 'x'.repeat(65) }, { key: 5 }, { key: ['a'] }, null]) {
      expect(bg.settingsDeleteKey(bad)).toBe('')
    }
  })
  // what a delete frame does to storage is executed in sw-settings.test.js
})

describe('notification counts', () => {
  test('notifications:read clamps to a non-negative integer, junk is -1', () => {
    expect(bg.unreadFromFrame({ unread: 3 })).toBe(3)
    expect(bg.unreadFromFrame({ unread: 2.9 })).toBe(2)
    expect(bg.unreadFromFrame({ unread: -4 })).toBe(0)
    expect(bg.unreadFromFrame({ unread: 1e12 })).toBe(99999)
    for (const bad of [{}, { unread: '3' }, { unread: Number.NaN }, { unread: Infinity }, null]) {
      expect(bg.unreadFromFrame(bad)).toBe(-1)
    }
  })
  test('wired: seen:update (mentions/inbox only) and notifications:read set the badge, seen still forwards', () => {
    expect(BG).toMatch(
      /if \(msg\.surface === 'mentions' \|\| msg\.surface === 'inbox'\) setUnreadNotifCount\(0\)\s*\n\s*broadcastToTabs\(\{\s*\n\s*type: 'seen_update'/,
    )
    expect(BG).toMatch(
      /case 'notifications:read': \{\s*\n\s*const n = unreadFromFrame\(msg\)\s*\n\s*if \(n >= 0\) setUnreadNotifCount\(n\)/,
    )
  })
})

describe('bookmarks:changed', () => {
  test('frame needs a base36 id and a real boolean', () => {
    expect(bg.bookmarkFrame({ id: 'a1b2', on: true })).toEqual({ id: 'a1b2', on: true })
    for (const bad of [
      { id: 'a1b2', on: 'yes' },
      { id: '../x', on: true },
      { id: '', on: false },
      { id: 'a'.repeat(13), on: true },
      { on: true },
      null,
    ]) {
      expect(bg.bookmarkFrame(bad)).toBeNull()
    }
  })
  test('the overlay applies it to feedBookmarks', () => {
    const run = new Function(
      `${src('feed-engage.js').split('function feedVoteOptimistic')[0]}; return { feedBookmarks, feedOnBookmarkPush }`,
    )()
    expect(run.feedOnBookmarkPush({ id: 'k3', on: true })).toBe(true)
    expect(run.feedBookmarks.get('k3')).toBe(true)
    expect(run.feedOnBookmarkPush({ id: 'k3', on: false })).toBe(true)
    expect(run.feedBookmarks.get('k3')).toBe(false)
    expect(run.feedOnBookmarkPush({ id: '<img>', on: true })).toBe(false)
    expect(run.feedOnBookmarkPush({ id: 'k4', on: 1 })).toBe(false)
    expect(run.feedBookmarks.has('k4')).toBe(false)
  })
})

describe('whisper:new', () => {
  const frame = {
    id: 9,
    external_message_id: 'ext-1',
    from_twitch_id: '123',
    from_twitch_login: 'alice',
    from_display_name: 'Alice',
    from_color: '#ff00ff',
    content: 'hi\u0007 there',
    created_at: '2026-11-05T10:00:00.000Z',
  }
  test('shaped into the dm_new twitch whisper the overlay already dedups', () => {
    expect(bg.shapeWhisperFrame(frame)).toEqual({
      platform: 'twitch',
      id: '9',
      external_message_id: 'ext-1',
      from_twitch_id: '123',
      from_twitch_login: 'alice',
      from_display_name: 'Alice',
      from_color: '#ff00ff',
      content: 'hi  there',
      created_at: '2026-11-05T10:00:00.000Z',
    })
  })
  test('hostile fields are dropped or bounded', () => {
    const w = bg.shapeWhisperFrame({
      ...frame,
      from_color: '#ff00ff; x',
      content: 'x'.repeat(5000),
      created_at: 'junk',
    })
    expect(w.from_color.length).toBe(7)
    expect(w.content.length).toBe(2000)
    expect(w.created_at).toBe('')
    expect(bg.shapeWhisperFrame({ ...frame, content: '  ' })).toBeNull()
    expect(bg.shapeWhisperFrame({ ...frame, from_twitch_login: '' })).toBeNull()
    expect(bg.shapeWhisperFrame(null)).toBeNull()
  })
})

describe('handler wiring for the remaining frames', () => {
  test('follows:changed runs the followed-users refresh', () => {
    expect(BG).toMatch(/case 'follows:changed':\s*\n\s*fetchFollowedUsers\(\)/)
  })
  test('mention-rules:changed and bookmarks:changed reach the tabs', () => {
    expect(BG).toMatch(/case 'mention-rules:changed':\s*\n\s*broadcastToTabs\(\{ type: 'mention_rules_changed' \}\)/)
    expect(BG).toMatch(/type: 'bookmark_changed', id: b\.id, on: b\.on/)
  })
  test('user_settings:update with plus refreshes the account and your cosmetics', () => {
    expect(BG).toMatch(/'plus_expires_at' in msg\) refreshPlusState\(\)/)
    expect(extractFn(BG, 'refreshPlusState')).toMatch(/fetchUserInfo[\s\S]*cosmetic_changed[\s\S]*account_changed/)
  })
  test('cosmetic:changed is bounded before it fans out', () => {
    expect(BG).toMatch(/changedIds\.slice\(0, 200\)\.map\(\(i\) => i\.slice\(0, 80\)\)/)
  })
})

describe('mention-rules:changed in the overlay', () => {
  function rig(state, auth = true) {
    let loads = 0
    const mrState = { loaded: true, loading: false, draft: null, editId: null, ...state }
    const fn = new Function(
      'mrState',
      'hsAuthToken',
      'mrLoad',
      `${extractFn(src('mention-rules.js'), 'mrOnPush')}; return mrOnPush`,
    )(mrState, auth, () => {
      loads++
    })
    return { fn, loads: () => loads }
  }
  test('reloads when idle', () => {
    const r = rig({})
    expect(r.fn()).toBe(true)
    expect(r.loads()).toBe(1)
  })
  test('leaves a half-written rule, an unopened list, a load in flight and a signed-out viewer alone', () => {
    for (const [s, auth] of [
      [{ draft: {} }, true],
      [{ editId: 3 }, true],
      [{ loaded: false }, true],
      [{ loading: true }, true],
      [{}, false],
    ]) {
      const r = rig(s, auth)
      expect(r.fn()).toBe(false)
      expect(r.loads()).toBe(0)
    }
  })
})

describe('cosmetic:changed refreshes flair and open cards', () => {
  test('flair held under a named id is asked again; unknown ids are not', () => {
    let flushed = 0
    const queued = new Set()
    const map = new Map([['7', { at: 123, v: null }]])
    const fn = new Function(
      '_hsmSets',
      '_hsmFlush',
      `${extractFn(src('name-marks-data.js'), 'hsMarksRefreshIds')}; return hsMarksRefreshIds`,
    )({ flair: { map, q: queued } }, () => {
      flushed++
    })
    expect(fn(['7', '99'])).toBe(1)
    expect(map.get('7').at).toBe(0)
    expect([...queued]).toEqual(['7'])
    expect(flushed).toBe(1)
    expect(fn(['99'])).toBe(0)
    expect(flushed).toBe(1)
    expect(fn('nope')).toBe(0)
  })

  function cardRig(active) {
    const cardCache = new Map([
      ['twitch:a', { payload: { profile: { id: 'u1' } } }],
      ['twitch:b', { payload: { profile: { id: 'u2' } } }],
    ])
    const profileCache = new Map([['twitch:a', { profile: { id: 'u1' } }]])
    let renders = 0
    const env = { activeProfileCard: active, _cardCache: cardCache, _profileCache: profileCache }
    const fn = new Function(
      'env',
      'fetchCardPayload',
      'renderProfileCardView',
      `let activeProfileCard = env.activeProfileCard; const _cardCache = env._cardCache; const _profileCache = env._profileCache;
${extractFn(src('profile-card.js'), 'pcRefreshCardFor')}; return pcRefreshCardFor`,
    )(
      env,
      async () => ({ profile: { id: 'u1', display_name: 'New Name' } }),
      () => {
        renders++
      },
    )
    return { fn, cardCache, profileCache, renders: () => renders }
  }
  test('drops cached card payloads for the named account only', () => {
    const r = cardRig(null)
    expect(r.fn(['u1'])).toBe(2)
    expect([...r.cardCache.keys()]).toEqual(['twitch:b'])
    expect(r.profileCache.size).toBe(0)
    expect(r.fn([])).toBe(0)
  })
  test('re-reads the open card when it is that account, keeping its extra fields', async () => {
    const open = { username: 'a', platform: 'twitch', data: { id: 'u1', display_name: 'Old', kickBio: 'keep' } }
    const r = cardRig(open)
    r.fn(['u1'])
    await new Promise((res) => setTimeout(res, 0))
    expect(open.data.display_name).toBe('New Name')
    expect(open.data.kickBio).toBe('keep')
    expect(r.renders()).toBe(1)
  })
  test('an open card for someone else is left alone', async () => {
    const open = { username: 'z', platform: 'twitch', data: { id: 'u9', display_name: 'Z' } }
    const r = cardRig(open)
    r.fn(['u1'])
    await new Promise((res) => setTimeout(res, 0))
    expect(open.data.display_name).toBe('Z')
    expect(r.renders()).toBe(0)
  })
})

describe('skipped on purpose (no ext surface)', () => {
  test('thread dms, dm echo, held-message and kick-moderation frames are not handled', () => {
    for (const t of [
      'dm:message',
      'dm:sent',
      'dm:thread-update',
      'message:approved',
      'message:flagged',
      'kick-moderation',
    ]) {
      expect(BG.includes(`case '${t}'`)).toBe(false)
    }
  })
})
