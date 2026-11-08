/**
 * A youtube send finds a chat frame.
 *
 * With the overlay on, a youtube watch tab has no live_chat iframe (native
 * chat is collapsed, the frame unloads). A send into that tab is heard only by
 * the page's other scripts, which answer nothing, so it resolved empty, not
 * with "receiving end does not exist". Both send paths took empty as final: a
 * send from heatsync.org acked ok:false with no reason, and the overlay's own
 * composer said "no response from tab". Neither ever opened the bridge tab
 * built for exactly this (gauntlet, lofigirl, 2026-11-02).
 *
 * The real sendYoutubeChat + bridge code is carved out of background.js and
 * run against fake tabs.
 */

import { describe, expect, test } from 'bun:test'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()
const start = BG_SRC.indexOf('const TAB_BRIDGE_MARK')
const end = BG_SRC.indexOf('// ========== COSMETICS', start)
const CARVED = BG_SRC.slice(start, end)

const VID = '0sfDth4lMLc'

// watch tab 1 has no chat frame: it answers empty. a bridge tab answers like youtube-content.js.
function load({
  watchAnswers = undefined,
  watchThrows = null,
  bridgeAnswers = { ok: true, ytUsername: 'mellenpvp' },
} = {}) {
  const tabs = new Map([[1, { id: 1, url: `https://www.youtube.com/watch?v=${VID}` }]])
  const sent = []
  let nextId = 100
  const browser = {
    tabs: {
      onRemoved: { addListener() {} },
      get: async (id) => tabs.get(id) ?? Promise.reject(new Error('no tab')),
      query: async () => [...tabs.values()],
      update: async () => {},
      create: async ({ url }) => {
        const t = { id: nextId++, url }
        tabs.set(t.id, t)
        return t
      },
      remove: async (id) => tabs.delete(id),
      sendMessage: async (id, msg) => {
        sent.push({ id, type: msg.type })
        const bridge = (tabs.get(id)?.url || '').includes('#hs-bridge')
        if (msg.type === 'youtube_bridge_ping')
          return bridge ? { ok: true, hasInput: true, disabled: false } : undefined
        if (bridge) return bridgeAnswers
        if (watchThrows) throw new Error(watchThrows)
        return watchAnswers
      },
    },
  }
  const fn = new Function('browser', 'log', `${CARVED}\nreturn { sendYoutubeChat, driveYoutubeChat }`)
  const { sendYoutubeChat, driveYoutubeChat } = fn(browser, () => {})
  return { send: sendYoutubeChat, drive: driveYoutubeChat, sent }
}

describe('a youtube send finds a chat frame', () => {
  test('carve markers found', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })

  test('a watch tab with no chat frame hands the send to a bridge tab', async () => {
    const { send, sent } = load()
    const r = await send({ videoId: VID, text: 'hi' })
    expect(r).toEqual({ ok: true, ytUsername: 'mellenpvp' })
    expect(sent.filter((s) => s.type === 'youtube_send_relay').map((s) => s.id)).toEqual([1, 100])
  })

  test('a chat frame that answered is final, even when it says no', async () => {
    const { send, sent } = load({ watchAnswers: { ok: false, error: 'rate_limited' } })
    expect(await send({ videoId: VID, text: 'hi' })).toEqual({ ok: false, error: 'rate_limited' })
    expect(sent.some((s) => s.id === 100)).toBe(false)
  })

  test('a frame that died mid-send is not re-driven, so nothing posts twice', async () => {
    const { send, sent } = load({ watchThrows: 'The message port closed before a response was received.' })
    const r = await send({ videoId: VID, text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('port closed')
    expect(sent.some((s) => s.id === 100)).toBe(false)
  })

  test('a failure always says why', async () => {
    const { send } = load({ bridgeAnswers: null })
    const r = await send({ videoId: VID, text: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('a mod action on a watch tab with no chat frame reaches the bridge tab too', async () => {
    const { drive, sent } = load({ bridgeAnswers: { ok: true } })
    const r = await drive({ videoId: VID, payload: { type: 'youtube_mod_relay', action: 'delete', msgId: 'x' } })
    expect(r).toEqual({ ok: true })
    expect(sent.filter((s) => s.type === 'youtube_mod_relay').map((s) => s.id)).toEqual([1, 100])
  })

  test('no video id and no youtube sender tab is refused, never guessed', async () => {
    const { send, sent } = load()
    expect(await send({ text: 'hi' })).toEqual({ ok: false, error: 'no_youtube_tab' })
    expect(sent).toEqual([])
  })
})
