/**
 * A line the history holds twice shows once, also when it is one leg of a send to twitch and kick.
 *
 * 11-28: mellen's lines sent from the desktop app to twitch and kick showed twice after a reload,
 * both rows [H], both with his twitch badges; somebody else's lines showed once. The server's twitch
 * ring had stored those lines twice (two workers wrote it), the worker merged the batch without
 * checking it against itself, and the pane folded the send like this: kick's copy came first
 * (kick stamps whole seconds, so it sorts above twitch's), the first twitch copy folded into it, and
 * the second twitch copy was judged as one more twitch leg of a row that already had one, so it
 * stood as its own row. A line with no kick leg was saved by the render's one-row-per-id rule; a
 * line the ring held once (WutFace) folded and showed once.
 *
 * The real foldSimulcastLegs (merged-tab.js) and hs-origins.js run; the worker part runs the real
 * background in the service-worker harness.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootSw, disposeAll } from './harness/sw.js'

const MC = join(import.meta.dir, '..', 'src', 'multichat')
const IRC = readFileSync(join(MC, 'irc.js'), 'utf8')
const fn = (src, name) => {
  const start = src.indexOf(`function ${name}(`)
  return src.slice(start, src.indexOf('\n}\n', start) + 2)
}
const SELF = { twitch: ['mellen'], kick: ['mellen'], youtube: [] }
globalThis.stripDupBypass = new Function(`const DUP_BYPASS_CHAR = '\\u{E0000}'
${fn(IRC, 'stripDupBypass')}
return stripDupBypass`)()
globalThis._unkickEmotes = (s) => String(s ?? '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1')
globalThis.isSelf = (m, p) => (SELF[p] || []).includes(String(m.user || '').toLowerCase())
globalThis.platformMark = (await import('../src/lib/palette.js')).platformMark
globalThis.safeSendMessage = () => Promise.resolve({ origins: [] })
const origins = await import('../src/multichat/hs-origins.js')
globalThis.hsOriginStamp = origins.hsOriginStamp
const lib = await import('../src/multichat/merged-tab.js')
afterAll(() => {
  for (const k of ['stripDupBypass', '_unkickEmotes', 'isSelf', 'platformMark', 'safeSendMessage', 'hsOriginStamp'])
    delete globalThis[k]
})
afterEach(disposeAll)

const T0 = 1_795_880_948_000 // a whole second, as kick stamps it
let n = 0
/** one platform message; `copy` is the same message delivered again (a fresh object, same id) */
const line = (platform, user, text, dt, sendId) => {
  const id = `${platform}-${++n}`
  if (sendId) origins.hsOriginNote(platform, id, sendId)
  return {
    platform,
    user,
    text,
    time: T0 + dt,
    id,
    channel: 'nl_kripp',
    badges: platform === 'twitch' ? 'moderator/1' : '',
  }
}
const copy = (m) => ({ ...m })
const shown = (msgs) => lib.foldSimulcastLegs(msgs).map((m) => `${m.platform}:${m.id}`)

describe('the pane folds a line held twice into one row', () => {
  test('kick first, the twitch line twice: one row (the 11-28 doubles)', () => {
    const k = line('kick', 'mellen', 'i wana do some shiiet', 0, 'send-a')
    const t = line('twitch', 'mellen', 'i wana do some shiiet', 544, 'send-a')
    expect(shown([k, t, copy(t)])).toEqual([`kick:${k.id}`])
  })

  test('the twitch line twice, then kick: one row', () => {
    const t = line('twitch', 'mellen', 'they had to keep it under', 0, 'send-b')
    const k = line('kick', 'mellen', 'they had to keep it under', 365, 'send-b')
    expect(shown([t, copy(t), k])).toEqual([`twitch:${t.id}`])
  })

  test('held once, it already was one row (why WutFace showed once)', () => {
    const k = line('kick', 'mellen', 'WutFace', 0, 'send-c')
    const t = line('twitch', 'mellen', 'WutFace', 360, 'send-c')
    expect(shown([k, t])).toEqual([`kick:${k.id}`])
  })

  test('no send id known yet, folded by name: still one row', () => {
    const k = line('kick', 'mellen', 'deadcock', 0)
    const t = line('twitch', 'mellen', 'deadcock', 300)
    expect(shown([k, t, copy(t)])).toEqual([`kick:${k.id}`])
  })

  test("somebody else's line held twice: one row", () => {
    const t = line('twitch', 'dongblob', 'underkeep demo is super short', 0)
    expect(shown([t, copy(t)])).toEqual([`twitch:${t.id}`])
  })

  test('a removal that reached only the second copy still greys the row', () => {
    const k = line('kick', 'mellen', 'test', 0, 'send-d')
    const t = line('twitch', 'mellen', 'test', 400, 'send-d')
    const [row] = lib.foldSimulcastLegs([k, t, { ...t, cleared: true, clearedReason: 'deleted' }])
    expect(row.id).toBe(k.id)
    expect(row.cleared).toBe(true)
  })

  test('the same words said twice are two lines (two ids are two messages)', () => {
    const a = line('twitch', 'dongblob', 'urrghh', 0)
    const b = line('twitch', 'dongblob', 'urrghh', 2000)
    expect(shown([a, b])).toEqual([`twitch:${a.id}`, `twitch:${b.id}`])
  })

  test('one id in two rooms (shared chat) is not one message', () => {
    const a = line('twitch', 'x', 'hi', 0)
    expect(shown([a, { ...a, channel: 'otherroom' }])).toHaveLength(2)
  })
})

describe("the worker's history merge holds a line once", () => {
  const rec = (id, user, content, timestamp) => ({
    type: 'privmsg',
    channel: 'nl_kripp',
    timestamp,
    username: user,
    displayName: user,
    content,
    color: '#FF8700',
    badges: 'moderator/1',
    emotes: '',
    id,
  })
  const ids = (sw) => sw.eval(`BG_IRC.channels.get('nl_kripp').getAll().map((m) => m.id)`)

  test("the server's backlog naming a line twice adds it once", async () => {
    const sw = await bootSw({ tabs: [{ id: 7, url: 'https://www.twitch.tv/nl_kripp' }], sockets: 'open' })
    sw.eval(`BG_IRC.channelTabs.set('nl_kripp', new Set([7])); bgIrcEnsureChannel('nl_kripp')`)
    const now = Date.now()
    const a = rec('a1', 'mellen', 'i wana do some shiiet', now - 5000)
    const b = rec('b1', 'dongblob', 'damn', now - 4000)
    sw.socket().receive({ type: 'irc:backlog', channel: 'nl_kripp', messages: [a, a, b, b, rec('c1', 'x', 'hi', now)] })
    await sw.settle()
    expect(ids(sw)).toEqual(['a1', 'b1', 'c1'])
  })
})
