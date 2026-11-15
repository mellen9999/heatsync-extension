/**
 * Flair set or cleared on heatsync.org: the server sends account:changed, the
 * background relays account_changed, and the panel asks again for every flair
 * it holds, so your own rows repaint as soon as the answer lands. Before, the old badge stayed up to the 10-minute flair
 * ttl after a clear (2026-11-05).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './en-t.js'

const dir = join(import.meta.dir, '..', 'src', 'multichat')
const strip = (s) => s.replace(/^export \{[\s\S]*?\}\s*$/m, '')
const code =
  strip(readFileSync(join(dir, 'name-marks.js'), 'utf8')) + readFileSync(join(dir, 'name-marks-data.js'), 'utf8')

const ROW = {
  flair_type: 'twitch_sub',
  broadcaster_login: 'x',
  badge_url: 'https://static-cdn.jtvnw.net/badges/v1/x/1',
}

function rig(tr = t, extra = {}) {
  let onMessage = null
  const rows = []
  const document = {
    getElementById: (id) => (id === 'hs-mc-messages' ? { querySelectorAll: () => rows } : null),
  }
  const env = {
    document,
    chrome: { runtime: { onMessage: {} } },
    cleanup: {
      addListener: (_t, fn) => {
        onMessage = fn
      },
      setTimeout: () => 1,
      setPageTimeout: () => 1,
    },
    getSetting: () => undefined,
    // the server's answer after the clear: you have no flair, the other chatter keeps theirs
    safeSendMessage: async ({ kind, ids }) => ({
      ok: true,
      body: kind === 'flair' ? { flairs: ids.includes('7') ? { 7: ROW } : {} } : { users: {} },
    }),
    getSenderEmotes: () => null,
    isSelf: (m) => m.user === 'me',
    pinAfterInPlaceUpdate: () => {},
    t: tr,
    getHsBadgeId: undefined,
    badgeById: undefined,
    ...extra,
  }
  const names = Object.keys(env)
  const api = new Function(
    ...names,
    `${code}; return { _hsmSets, hsMarksRowHtml, hsMarksSelfRowHtml, hsMarksRepaint }`,
  )(...names.map((k) => env[k]))
  const badge = { url: 'https://static-cdn.jtvnw.net/badges/v1/x/1', title: 'sub' }
  const row = (user, userId) => {
    const m = { user, userId, platform: 'twitch' }
    api._hsmSets.flair.map.set(userId, { v: badge, at: Date.now(), asked: 0 })
    const slot = { innerHTML: api.hsMarksRowHtml(m, userId).replace(/^<span class="hs-mc-marks">|<\/span>$/g, '') }
    rows.push({ _hsMsg: m, querySelector: () => slot })
    return slot
  }
  return { api, row, rows, send: (msg) => onMessage(msg) }
}

describe("a picked heatsync badge takes the flame's place", () => {
  const flameFor = (badges) => {
    const r = rig(t, {
      getHsBadgeId: (uid) => badges[uid] ?? null,
      badgeById: (id) => (id === 'ember' ? { id } : null),
    })
    return r.api.hsMarksRowHtml({ user: 'me', userId: '42', platform: 'twitch' }, '42')
  }
  test('no badge: the flame shows', () => expect(flameFor({})).toContain('hs-mark-flame'))
  test('a badge: no flame', () => expect(flameFor({ 42: 'ember' })).not.toContain('hs-mark-flame'))
  test('an id this build cannot draw keeps the flame', () =>
    expect(flameFor({ 42: 'from_the_future' })).toContain('hs-mark-flame'))
})

describe('the flame and heat titles speak the viewer language', () => {
  const pseudo = (key) => `<${key}>`
  const wearer = (tr, heat) => {
    const { api } = rig(tr)
    api._hsmSets.heat.map.set('me', { v: heat, at: Date.now(), asked: 0 })
    return api.hsMarksRowHtml({ user: 'me', userId: '42', platform: 'twitch' }, '42')
  }

  test('english is exactly what the vendored module prints', () => {
    expect(wearer(t, 0)).toContain('class="hs-mark-flame" title="heatsync user"')
    expect(wearer(t, 120)).toContain(' title="heat">')
  })

  test('another locale replaces both, escaped', () => {
    expect(wearer(pseudo, 0)).toContain('class="hs-mark-flame" title="&#60;mc_mark_user&#62;"')
    expect(wearer(pseudo, 120)).toContain(' title="&#60;lib_opt_heat&#62;">')
  })
})

describe('account_changed drops your own flair', () => {
  test('every held flair is asked again; your row repaints without the old badge, others keep theirs', async () => {
    const { row, send } = rig()
    const mine = row('me', '42')
    const theirs = row('other', '7')
    expect(mine.innerHTML).toContain('hs-mark-flair')
    send({ type: 'account_changed' })
    await new Promise((r) => setTimeout(r, 0))
    expect(mine.innerHTML).not.toContain('hs-mark-flair')
    expect(theirs.innerHTML).toContain('hs-mark-flair')
  })

  test('any other message leaves the cache alone', () => {
    const { api, row, send } = rig()
    row('me', '42')
    send({ type: 'something_else' })
    expect(api._hsmSets.flair.map.get('42')?.v).toBeTruthy()
  })
})

// a send to several chats keeps whichever echo lands first: your kick or youtube copy must wear the same mark
describe('your own line on kick or youtube wears your marks', () => {
  const selfRig = (extra = {}) =>
    rig(t, {
      isSelf: (m) => (m.platform === 'kick' ? m.user === 'mekick' : m.user === 'me'),
      selfNamesFor: (p) => (p === 'twitch' ? ['me'] : ['mekick']),
      ...extra,
    })
  test('the flame shows on your kick row', () => {
    expect(selfRig().api.hsMarksSelfRowHtml('')).toContain('hs-mark-flame')
  })
  test('your twitch heat drives the bar there too', () => {
    const { api } = selfRig()
    api._hsmSets.heat.map.set('me', { v: 120, at: Date.now(), asked: 0 })
    const html = api.hsMarksSelfRowHtml('')
    expect(html).toContain('hs-mark-heat')
    expect(html).not.toContain('hs-mark-flame')
  })
  test('a heat change repaints your kick row; a stranger on kick stays bare', () => {
    const { api, rows } = selfRig()
    const slot = (m) => {
      const x = { innerHTML: 'old' }
      rows.push({ _hsMsg: m, querySelector: () => x })
      return x
    }
    const mine = slot({ user: 'mekick', platform: 'kick' })
    const theirs = slot({ user: 'me', platform: 'kick' })
    api._hsmSets.heat.map.set('me', { v: 120, at: Date.now(), asked: 0 })
    api.hsMarksRepaint(new Set(['me']))
    expect(mine.innerHTML).toContain('hs-mark-heat')
    expect(theirs.innerHTML).toBe('old')
  })
})
