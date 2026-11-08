// A went-live / switch / offline row names the streamer on the LINE's platform:
// the frame's userId seats the paint at once, a kick line never reads a twitch
// login's id or colour, the colour chain runs frame -> follow:colors -> seen in
// that platform's chat -> that platform's profile -> palette, and the went-live
// at the stream's start goes into a twitch tab's history exactly once.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPaintLookupSafeId } from '../src/lib/paint-spec.js'
import { escapeHtml } from '../src/lib/utils.js'
import { historyWentLiveEvent, streamEventUserId } from '../src/multichat/stream-line-ids.js'
import { bgSource } from './bg-src.js'
import { mainSource } from './main-src.js'

const MAIN = mainSource()
const IRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'irc.js'), 'utf8')
const BG = bgSource()

const queued = []
const knownUserIds = new Map([['kick:quin', '71092938']]) // quin's LINKED twitch id, from chat
const knownColors = new Map([['quin', '#112233']]) // a twitch "quin" colour
const platSeenColors = new Map()
const lookupColors = new Map()
const G = {
  isPaintLookupSafeId,
  escapeHtml,
  sanitizeColor: (c) => (/^#[0-9a-f]{3,6}$/i.test(c) ? c : '#fff'),
  hsUsernameColor: () => '#PALETTE',
  getHsPickedColor: (uid) => (uid === 'kick_77' ? '#445566' : null),
  knownUserIds,
  knownColors,
  platSeenColors,
  _hsUserColorCache: lookupColors,
  userKey: (login, plat) => `${plat}:${login}`,
  queuePaintLookup: (uid) => queued.push(['paint', uid]),
  queueMcCosmeticsLookup: (uid) => queued.push(['cosm', uid]),
  queueNameColorLookup: (uid) => queued.push(['colour', uid]),
  hsPaintRender: () => null,
  paintPhaseNow: () => '0s',
  hsNameColourDecl: (c) => `--hs-name-c:${c}`,
  getMcPaintStyle: () => '',
}
const saved = {}
let ns
beforeAll(async () => {
  for (const [k, v] of Object.entries(G)) {
    saved[k] = globalThis[k]
    globalThis[k] = v
  }
  ns = await import('../src/multichat/name-style.js')
})
afterAll(() => {
  for (const k of Object.keys(G)) globalThis[k] = saved[k]
})

const row = (o) => ns.hsNameParts({ name: 'quin', login: 'quin', exact: true, ...o })

describe('a kick line resolves with kick ids and colour, never twitch', () => {
  test('the kick id seats kick_<id>; the linked twitch id chat knows is not borrowed', () => {
    const p = row({ platform: 'kick', userId: '77' })
    expect(p.uid).toBe('kick_77')
    expect(p.data.nplat).toBe('kick')
    const bare = row({ platform: 'kick' })
    expect(bare.uid).toBe('')
  })
  test('a twitch colour for the same login never colours a kick line', () => {
    expect(row({ platform: 'kick' }).style).toBe('color:#PALETTE')
    platSeenColors.set('kick:quin', '#abcdef')
    expect(row({ platform: 'kick' }).style).toBe('color:#abcdef')
    platSeenColors.delete('kick:quin')
  })
  test('the kick profile lookup answers the id and the colour, and restyles the row', async () => {
    const el = {
      dataset: { hsNlogin: 'lookme', hsNsrc: 'kick' },
      textContent: 'lookme',
      style: { setProperty() {} },
      attr: '',
      setAttribute(k, v) {
        if (k === 'style') this.attr = v
      },
    }
    const stubs = {
      resolveIdentity: async () => ({ ok: true, profile: { kick_user_id: 99, color: '#778899' } }),
      hasResolvedHsPaint: () => false,
      clearHsPaintFromElement() {},
      CSS: { escape: (x) => x },
      document: { querySelectorAll: () => [el] },
    }
    const prev = {}
    for (const [k, v] of Object.entries(stubs)) {
      prev[k] = globalThis[k]
      globalThis[k] = v
    }
    try {
      ns.hsNameResolveKick('lookme')
      await new Promise((r) => setTimeout(r, 5))
      expect(el.dataset.hsNuid).toBe('kick_99')
      expect(el.dataset.hsNplat).toBe('kick')
      expect(el.attr).toBe('color:#778899')
    } finally {
      for (const k of Object.keys(stubs)) globalThis[k] = prev[k]
    }
  })
})

describe('the frame userId seats the paint id at once', () => {
  test('twitch: the id queues the paint + 7tv lookup before any profile lookup', () => {
    queued.length = 0
    const p = ns.hsNameParts({ name: 'zed', login: 'zed', platform: 'twitch', userId: '555', exact: true })
    expect(p.uid).toBe('555')
    expect(queued).toContainEqual(['cosm', '555'])
  })
  test('youtube: a UC id becomes yt_UC…', () => {
    const p = ns.hsNameParts({ name: 'yy', platform: 'youtube', userId: 'UCabcdefghijklmnopqrstuv', exact: true })
    expect(p.uid).toBe('yt_UCabcdefghijklmnopqrstuv')
  })
  test('the row builder hands the validated frame id to the name', () => {
    expect(MAIN).toContain('streamEventUserId(evtPlat, m.userId)')
    expect(MAIN).toContain('exact: true')
  })
})

describe('the colour chain order', () => {
  test('frame colour beats everything', () => {
    platSeenColors.set('kick:quin', '#abcdef')
    expect(row({ platform: 'kick', userId: '77', colour: '#010203' }).style).toBe('color:#010203')
    platSeenColors.delete('kick:quin')
  })
  test('kick: seen in kick chat -> kick profile -> picked -> palette', () => {
    platSeenColors.set('kick:quin', '#abcdef')
    expect(row({ platform: 'kick', userId: '77' }).style).toBe('color:#abcdef')
    platSeenColors.delete('kick:quin')
    expect(row({ platform: 'kick', userId: '77' }).style).toBe('color:#445566')
    expect(row({ platform: 'kick', userId: '78' }).style).toBe('color:#PALETTE')
  })
  test('twitch: chat-seen -> profile lookup -> palette', () => {
    expect(row({ platform: 'twitch', userId: '1' }).style).toBe('color:#112233')
    knownColors.delete('quin')
    lookupColors.set('quin', '#334455')
    expect(row({ platform: 'twitch', userId: '1' }).style).toBe('color:#334455')
    lookupColors.delete('quin')
    expect(row({ platform: 'twitch', userId: '1' }).style).toBe('color:#PALETTE')
    knownColors.set('quin', '#112233')
  })
  test('the row asks follow:colors before chat, only for twitch lines', () => {
    expect(MAIN).toContain("if (!userColor && evtPlat === 'twitch') userColor = streamColorMap.get(chLc) || ''")
  })
})

describe('a hostile userId is dropped', () => {
  test('digits for twitch/kick, UC + 22 for youtube; everything else is empty', () => {
    expect(streamEventUserId('twitch', '12345')).toBe('12345')
    expect(streamEventUserId('kick', 987)).toBe('987')
    expect(streamEventUserId('youtube', 'UCabcdefghijklmnopqrstuv')).toBe('UCabcdefghijklmnopqrstuv')
    for (const bad of [
      '',
      'abc',
      '12 34',
      '1'.repeat(21),
      '<img onerror=x>',
      'kick_77',
      null,
      undefined,
      {},
      [],
      1.5,
      -3,
    ]) {
      expect(streamEventUserId('twitch', bad)).toBe('')
      expect(streamEventUserId('kick', bad)).toBe('')
    }
    expect(streamEventUserId('youtube', '12345')).toBe('')
    expect(streamEventUserId('youtube', 'UCshort')).toBe('')
    expect(streamEventUserId('youtube', `UC${'a'.repeat(23)}`)).toBe('')
  })
  test('the service worker bounds what it caches and rebroadcasts', () => {
    expect(BG).toContain('function streamFrameWho')
    const room = BG.slice(BG.indexOf("case 'stream:update':"), BG.indexOf("case 'stream:redeem':"))
    expect(room).toContain('...streamFrameWho(msg)')
  })
})

describe('follow:history keeps each row colour and userId', () => {
  test('the service worker carries userId through cache + broadcast + the poll go-live', () => {
    const follow = BG.slice(BG.indexOf('function handleFollowStreamEvent'), BG.indexOf('// One-shot catch-up'))
    expect(follow.match(/userId: who\.userId/g)?.length).toBe(2)
    const wl = BG.slice(BG.indexOf('function announceWentLive'), BG.indexOf('// Add or update one entry'))
    expect(wl.match(/userId: who\.userId/g)?.length).toBe(2)
  })
  test('the replay builds each row from its own stored colour and userId', () => {
    const at = MAIN.indexOf('function processFollowHistory')
    const fn = MAIN.slice(at, MAIN.indexOf('// Process follow colors', at))
    expect(fn).toContain("color: e.color || ''")
    expect(fn).toContain('userId: streamEventUserId(e.platform, e.userId)')
    expect(fn).toContain('hermesToggles?.online')
  })
  test('the room and follow listeners put the frame colour + userId on the row', () => {
    expect(MAIN.match(/userId: streamEventUserId\(msg\.platform, msg\.userId\)/g)?.length).toBe(2)
  })
})

describe('went live at the stream start, in history', () => {
  const NOW = 1_700_000_000_000
  const info = { start: NOW - 3_600_000, game: 'Just Chatting', userId: '71092938' }
  test('inserted only when the loaded history reaches back to the start', () => {
    const e = historyWentLiveEvent('quin69', info, NOW - 4_000_000, NOW)
    expect(e.text).toBe('[quin69] ◆ went live — Just Chatting')
    expect(e.time).toBe(info.start)
    expect(e.eventClass).toBe('event-online')
    expect(e.userId).toBe('71092938')
    expect(historyWentLiveEvent('quin69', info, NOW - 1_000_000, NOW)).toBeNull()
    expect(historyWentLiveEvent('quin69', info, undefined, NOW)).toBeNull()
    expect(historyWentLiveEvent('quin69', { ...info, start: NOW + 5 }, NOW - 4_000_000, NOW)).toBeNull()
  })
  test('the id is stable per stream, so it can never double', () => {
    const a = historyWentLiveEvent('quin69', info, NOW - 4_000_000, NOW)
    const b = historyWentLiveEvent('quin69', info, NOW - 9_000_000, NOW + 60_000)
    expect(a.id).toBe(b.id)
    expect(a.id).toBe(`went-live:quin69:${info.start}`)
  })
  test('no game: just "went live"; a hostile id is dropped', () => {
    const e = historyWentLiveEvent('quin69', { start: info.start, userId: 'x<y' }, NOW - 4_000_000, NOW)
    expect(e.text).toBe('[quin69] ◆ went live')
    expect(e.userId).toBe('')
  })
  test('gated by the online toggle, inserted by id, no notification or tab light', () => {
    const at = MAIN.indexOf('async function historyWentLive')
    const fn = MAIN.slice(at, MAIN.indexOf('async function saveStreamEvent', at))
    expect(fn).toContain('!hermesToggles?.online')
    expect(fn).toContain('m.id === evt.id')
    expect(fn).not.toContain('notifyStreamEvent')
    expect(fn).not.toContain('has-stream-event')
    expect(fn).not.toContain('saveStreamEvent(')
  })
  test('runs after the twitch history lands, first load and re-pull', () => {
    expect(IRC.match(/historyWentLive\(ch\)/g)?.length).toBe(2)
  })
})
