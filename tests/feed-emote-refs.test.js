/**
 * Feed posts vouch their emotes (emote_refs).
 *
 * Regression anchor (2026-10-09): every feed post made from the extension
 * stored emote_refs NULL, so an FFZ emote picked from the composer's search
 * ("goodluck") rendered as plain text for everyone but the sender. The body
 * postFeedMessage / _quickOpToFeed sent carried only content (+ media/reply).
 *
 * Harness: carve the shipped source out of social.js / input.js, evaluate it
 * beside the byte-mirrored site builder (src/lib/emote-refs.js), capture the
 * body handed to apiFetch.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const SOCIAL = readFileSync(join(ROOT, 'src', 'multichat', 'social.js'), 'utf8')
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
const LIB = readFileSync(join(ROOT, 'src', 'lib', 'emote-refs.js'), 'utf8').replace(/^export /gm, '')

function carve(src, a, b) {
  const s = src.indexOf(a)
  const e = src.indexOf(b, s)
  if (s === -1 || e === -1) throw new Error(`carve markers not found: ${a} .. ${b}`)
  return src.slice(s, e)
}

const feedSrc = carve(SOCIAL, '// ── feed emote vouching ──', '\nlet discoverTags = []')
const quickSrc = carve(INPUT, 'async function _quickOpToFeed(', 'async function _openWhisperFor(')

const FFZ = 'https://cdn.frankerfacez.com/emote/123456/1'
const STV = 'https://cdn.7tv.app/emote/01FY9WEBXR00077WTWSFD40R6K/1x.avif'

// picks: made in the composer for this post · mine: your own set · room: the open chat tab's emotes
function harness({ picks = [], mine = {}, room = {} } = {}) {
  const calls = []
  const box = {}
  const stubs = {
    document: { getElementById: () => ({ value: 'x', dataset: {}, style: {} }) },
    hsAuthToken: 'tok',
    wysiwygEnabled: false,
    pendingMessage: '',
    activeThread: null,
    currentTab: 'feed',
    feedMessages: [],
    lawBox: () => box,
    viewerPersonalEmotes: new Map(Object.entries(mine)),
    emoteCache: new Map(),
    lookupPublicEmote: (n) => room[n],
    apiFetch: async (_path, opts) => {
      calls.push(opts.body)
      return { ok: true, data: {} }
    },
    buildFeedInlineNotif: () => null,
    injectInlineNotif: () => {},
    updateCharCount: () => {},
    hideInputBar: () => {},
    updateInputPlaceholder: () => {},
    renderFeed: () => {},
    isOpMsg: () => false,
    t: (k) => k,
    cleanup: { setTimeout: () => {} },
    showToast: () => {},
    truncateSafe: (s) => s,
    _extractMcMsgText: () => 'gg goodluck',
  }
  const names = Object.keys(stubs)
  const factory = new Function(
    ...names,
    `${LIB}\n${feedSrc}\n${quickSrc}\nreturn { postFeedMessage, _quickOpToFeed, pinPickedEmote }`,
  )
  const api = factory(...names.map((n) => stubs[n]))
  for (const [name, e] of picks)
    api.pinPickedEmote({ name, url: e.url, provider: e.source, zeroWidth: !!e.zeroWidth }, box)
  return { ...api, calls }
}

describe('feed post emote_refs', () => {
  test('a picked FFZ emote sends a cdn.frankerfacez.com ref', async () => {
    const { postFeedMessage, calls } = harness({ picks: [['goodluck', { url: FFZ, source: 'ffz', zeroWidth: false }]] })
    await postFeedMessage('hello goodluck')
    expect(calls[0].emote_refs.goodluck.url).toBe(FFZ)
    expect(calls[0].emote_refs.goodluck.provider).toBe('ffz')
  })

  test('a picked 7TV emote sends a cdn.7tv.app ref', async () => {
    const { postFeedMessage, calls } = harness({ picks: [['Clap', { url: STV, source: '7tv', zeroWidth: false }]] })
    await postFeedMessage('Clap')
    expect(calls[0].emote_refs.Clap.url).toBe(STV)
    expect(calls[0].emote_refs.Clap.provider).toBe('7tv')
  })

  test('an emote you own keeps its inventory hash', async () => {
    const { postFeedMessage, calls } = harness({
      mine: { KEKW: { url: STV, source: '7tv', hash: 'abcdef0123456789' } },
    })
    await postFeedMessage('KEKW')
    expect(calls[0].emote_refs.KEKW.hash).toBe('abcdef0123456789')
  })

  test('text with no emotes sends no emote_refs key', async () => {
    const { postFeedMessage, calls } = harness({ picks: [['goodluck', { url: FFZ, source: 'ffz' }]] })
    await postFeedMessage('just words')
    expect('emote_refs' in calls[0]).toBe(false)
  })

  test('a non-https url is never vouched', async () => {
    const { postFeedMessage, calls } = harness({ mine: { Odd: { url: 'http://cdn.7tv.app/x', source: '7tv' } } })
    await postFeedMessage('Odd')
    expect('emote_refs' in calls[0]).toBe(false)
  })

  test("_quickOpToFeed (op to feed) vouches the line's own room emotes, not what the composer holds", async () => {
    const { _quickOpToFeed, calls } = harness({
      room: { goodluck: { url: FFZ, source: 'ffz' } },
      picks: [['goodluck', { url: STV, source: '7tv' }]],
    })
    await _quickOpToFeed('someone', {})
    expect(calls[0].emote_refs.goodluck.url).toBe(FFZ)
  })
})

describe('caller contracts', () => {
  test('quote thread auto-adds the picks it vouches', () => {
    const body = carve(INPUT, 'async function sendQuoteThread(', 'async function sendMessage(')
    expect(body).toContain('autoAddInputEmotes(words)')
  })
})
