/**
 * Flair set or cleared on heatsync.org: the server sends account:changed, the
 * background relays account_changed, and the panel asks again for every flair
 * it holds, so your own rows repaint as soon as the answer lands. Before, the old badge stayed up to the 10-minute flair
 * ttl after a clear (2026-11-05).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dir, '..', 'src', 'multichat')
const strip = (s) => s.replace(/^export \{[\s\S]*?\}\s*$/m, '')
const code =
  strip(readFileSync(join(dir, 'name-marks.js'), 'utf8')) + readFileSync(join(dir, 'name-marks-data.js'), 'utf8')

const ROW = {
  flair_type: 'twitch_sub',
  broadcaster_login: 'x',
  badge_url: 'https://static-cdn.jtvnw.net/badges/v1/x/1',
}

function rig() {
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
  }
  const names = Object.keys(env)
  const api = new Function(...names, `${code}; return { _hsmSets, hsMarksRowHtml }`)(...names.map((k) => env[k]))
  const badge = { url: 'https://static-cdn.jtvnw.net/badges/v1/x/1', title: 'sub' }
  const row = (user, userId) => {
    const m = { user, userId, platform: 'twitch' }
    api._hsmSets.flair.map.set(userId, { v: badge, at: Date.now(), asked: 0 })
    const slot = { innerHTML: api.hsMarksRowHtml(m, userId).replace(/^<span class="hs-mc-marks">|<\/span>$/g, '') }
    rows.push({ _hsMsg: m, querySelector: () => slot })
    return slot
  }
  return { api, row, send: (msg) => onMessage(msg) }
}

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
