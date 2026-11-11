// An open profile card re-asks the server when the account's color changes
// (profile:color) or any follow changes (follows:changed).
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootSw, disposeAll, tabSender } from './harness/sw.js'

afterEach(disposeAll)

const ROOT = join(import.meta.dir, '..', 'src', 'multichat')
const CARD = readFileSync(join(ROOT, 'profile-card.js'), 'utf8')
const STATE = readFileSync(join(ROOT, 'main-state.js'), 'utf8')
const fn = (code, name) => {
  const a = code.indexOf(`function ${name}(`)
  if (a < 0) throw new Error(`${name} not found`)
  return code.slice(a, code.indexOf('\n}', a) + 2)
}

function rig(open) {
  const caches = { card: new Map([['a', 1]]), profile: new Map([['a', 1]]) }
  let renders = 0
  const asked = []
  const api = new Function(
    'env',
    'fetchCardPayload',
    'renderProfileCardView',
    `const _cardCache = env.card; const _profileCache = env.profile; let activeProfileCard = env.open
${fn(CARD, 'pcRereadOpenCard')}
${fn(CARD, 'pcRefreshAfterFollowChange')}
${fn(CARD, 'pcRefreshCardFor')}
return { pcRefreshAfterFollowChange, pcRefreshCardFor }`,
  )(
    { ...caches, open },
    async (platform, username) => {
      asked.push([platform, username])
      return { profile: { relationship: { isFollowing: true }, color: '#00ff00' } }
    },
    () => {
      renders++
    },
  )
  return { ...api, caches, asked, renders: () => renders }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('open profile card', () => {
  test('a follow change drops every held card and re-reads the open one, relationship included', async () => {
    const open = {
      username: 'a',
      platform: 'twitch',
      data: { id: 'u1', relationship: { isFollowing: false }, kickBio: 'keep' },
    }
    const r = rig(open)
    expect(r.pcRefreshAfterFollowChange()).toBe(true)
    await tick()
    expect(r.caches.card.size + r.caches.profile.size).toBe(0)
    expect(r.asked).toEqual([['twitch', 'a']])
    expect(open.data.relationship.isFollowing).toBe(true)
    expect(open.data.kickBio).toBe('keep')
    expect(r.renders()).toBe(1)
  })
  test('with no card open (or an errored one) only the caches go', async () => {
    for (const open of [null, { username: 'a', data: { error: 'x' } }]) {
      const r = rig(open)
      expect(r.pcRefreshAfterFollowChange()).toBe(false)
      await tick()
      expect(r.asked).toEqual([])
      expect(r.caches.card.size).toBe(0)
    }
  })
  test('a profile:color for the open account re-asks it; for someone else it does not', async () => {
    const open = { username: 'a', platform: 'twitch', data: { id: 'u1', color: '#ffffff' } }
    const r = rig(open)
    r.pcRefreshCardFor(['u9'])
    await tick()
    expect(r.asked).toEqual([])
    r.pcRefreshCardFor(['u1'])
    await tick()
    expect(r.asked).toEqual([['twitch', 'a']])
    expect(open.data.color).toBe('#00ff00')
  })
  test('wired: the panel routes both pushes to the card', () => {
    expect(STATE).toMatch(/msg\?\.type === 'follows_changed'\) return void pcRefreshAfterFollowChange\(\)/)
    expect(STATE).toMatch(
      /applyLiveProfileColor\(msg\.usernames, msg\.color\)[\s\S]*pcRefreshCardFor\(\[msg\.userId\]\)/,
    )
  })
})

describe('worker', () => {
  test('follows:changed tells the tabs, and profile:color still does', async () => {
    const sw = await bootSw({
      cookies: [{ name: 'auth', value: 'tok-1', domain: 'heatsync.org' }],
      tabs: [{ id: 7, url: 'https://www.twitch.tv/kripp' }],
      sockets: 'open',
    })
    sw.socket().receive({ type: 'follows:changed' })
    sw.socket().receive({ type: 'profile:color', userId: 'u1', usernames: ['a'], color: '#00ff00' })
    await sw.settle()
    expect(sw.broadcasts('follows_changed')).toHaveLength(1)
    expect(sw.broadcasts('profile_color')[0].message).toMatchObject({ userId: 'u1', color: '#00ff00' })
  })
})

describe('profile:updated', () => {
  test('the worker forwards it as profile_updated; junk is dropped', async () => {
    const sw = await bootSw({
      cookies: [{ name: 'auth', value: 'tok-1', domain: 'heatsync.org' }],
      tabs: [{ id: 7, url: 'https://www.twitch.tv/kripp' }],
      sockets: 'open',
    })
    sw.socket().receive({ type: 'profile:updated', userId: 'u1' })
    sw.socket().receive({ type: 'profile:updated' })
    await sw.settle()
    expect(sw.broadcasts('profile_updated').map((m) => m.message.userId)).toEqual(['u1'])
  })
  test('the panel re-reads the open card for that account', () => {
    const social = readFileSync(join(ROOT, 'social.js'), 'utf8')
    expect(social).toContain("msg.type === 'profile_updated') return void pcRefreshCardFor([msg.userId])")
  })
  test('and that re-read does happen for the matching open card only', async () => {
    const open = { username: 'a', platform: 'twitch', data: { id: 'u1' } }
    const r = rig(open)
    r.pcRefreshCardFor(['u2'])
    await tick()
    expect(r.asked).toEqual([])
    r.pcRefreshCardFor(['u1'])
    await tick()
    expect(r.asked).toEqual([['twitch', 'a']])
  })
})

describe('card author room', () => {
  function authorRig(open) {
    const sent = []
    const timers = []
    const env = { open }
    const api = new Function(
      'env',
      'sent',
      'timers',
      `let activeProfileCard = env.open
const FEED_THREAD_KEEP_MS = 30000
const safeSendMessage = (m) => sent.push(m)
const cleanup = { setPageIntervalIfVisible: (fn) => timers.push(fn), clearInterval: () => {} }
${CARD.slice(CARD.indexOf('let pcAuthorRoom'), CARD.indexOf('function renderProfileCardView'))}
return { pcAuthorSync, set: (o) => { activeProfileCard = o } }`,
    )(env, sent, timers)
    return { ...api, sent, timers }
  }
  test('joins on open, ignores repeats, switches, leaves on close', () => {
    const r = authorRig({ data: { id: '42' } })
    r.pcAuthorSync()
    r.pcAuthorSync()
    expect(r.sent).toEqual([{ type: 'feed_author', room: 'author:42' }])
    r.set({ data: { id: 'kick_9' } })
    r.pcAuthorSync()
    r.set(null)
    r.pcAuthorSync()
    expect(r.sent.map((m) => m.room)).toEqual(['author:42', 'author:kick_9', null])
  })
  test('no id (loading / error card) holds no room; junk ids are refused', () => {
    const r = authorRig({ data: null })
    r.pcAuthorSync()
    r.set({ data: { id: 'x/../y' } })
    r.pcAuthorSync()
    expect(r.sent).toEqual([])
  })
  test('the render and both close paths sync it', () => {
    expect(fn(CARD, 'renderProfileCardView')).toContain('pcAuthorSync()')
    expect(fn(CARD, 'closeProfileCard')).toContain('pcAuthorSync()')
    expect(readFileSync(join(ROOT, 'main-tabs.js'), 'utf8')).toContain('activeProfileCard = null\n    pcAuthorSync()')
  })
  test('the worker joins/leaves the room beside the thread and re-joins on reconnect', async () => {
    const sw = await bootSw({
      cookies: [{ name: 'auth', value: 'tok-1', domain: 'heatsync.org' }],
      tabs: [{ id: 7, url: 'https://www.twitch.tv/kripp' }],
      sockets: 'open',
    })
    const tab = tabSender(7, 'https://www.twitch.tv/kripp')
    const ws = sw.socket()
    const rooms = () => ws.frames.filter((f) => f.type.startsWith('feed:') && f.feed !== 'new')
    await sw.send({ type: 'feed_thread', room: 'thread:abc' }, tab)
    await sw.send({ type: 'feed_author', room: 'author:42' }, tab)
    await sw.send({ type: 'feed_author', room: 'author:../x' }, tab) // junk: ignored
    await sw.send({ type: 'feed_author', room: 'author:42' }, tab) // repeat: no-op
    expect(rooms()).toEqual([
      { type: 'feed:join', feed: 'thread:abc' },
      { type: 'feed:join', feed: 'author:42' },
    ])
    await sw.send({ type: 'feed_author', room: null }, tab)
    expect(rooms().at(-1)).toEqual({ type: 'feed:leave', feed: 'author:42' })
  })
})
