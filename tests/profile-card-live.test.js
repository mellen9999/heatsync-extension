// An open profile card re-asks the server when the account's color changes
// (profile:color) or any follow changes (follows:changed).
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootSw, disposeAll } from './harness/sw.js'

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
