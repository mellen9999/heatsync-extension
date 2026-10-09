/**
 * Regression tests for the "/op inside thread view silently posts a thread
 * reply" bug (multichat overlay).
 *
 * postFeedMessage(text, { topLevel }) destructured the flag and then ignored
 * it: `if (activeThread) body.reply_to = activeThread.id` ran for EVERY
 * caller. /op's whole purpose is an explicit top-level post, but with a
 * thread open its post silently became a reply to that thread — the caller's
 * explicit intent overridden with no feedback. Meanwhile the feed-tab plain
 * send WANTS the contextual behavior (typing in thread view = replying), so
 * the fix is a gate, not a removal: `if (activeThread && !topLevel)`, with
 * the feed-tab caller passing no flag (contextual) and /op passing
 * topLevel: true (input.js).
 *
 * Harness: extract postFeedMessage's source from social.js and eval it with
 * stubbed globals; capture the body handed to apiFetch. Tests the real
 * shipped source, same pattern as feed-quote-paint.test.js.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOCIAL_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

function sliceBetween(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker)
  if (s === -1) throw new Error(`sliceBetween: start marker not found: ${startMarker}`)
  const e = src.indexOf(endMarker, s)
  if (e === -1) throw new Error(`sliceBetween: end marker not found: ${endMarker}`)
  return src.slice(s, e)
}

const fnSrc = sliceBetween(
  SOCIAL_SRC,
  'async function postFeedMessage(text, { topLevel = false, replyTo = null } = {}) {',
  '\nfunction startDiscoverPolling() {',
)

/** Build a fresh postFeedMessage with stubbed environment; returns the fn
 * plus a capture of every apiFetch call body. */
function harness({ activeThread = null, currentTab = 'feed', posted = null } = {}) {
  const calls = []
  const echoes = []
  const stubs = {
    document: {
      getElementById: () => ({ value: 'x', dataset: {}, style: {} }),
    },
    hsAuthToken: 'tok',
    wysiwygEnabled: false,
    pendingMessage: '',
    activeThread,
    currentTab,
    feedMessages: [],
    apiFetch: async (path, opts) => {
      calls.push({ path, body: opts.body })
      return { ok: true, data: posted ? { message: posted } : {} }
    },
    buildFeedInlineNotif: (f) => ({ notifType: 'op', msg: { base36_id: f.base36_id, created_at: f.created_at } }),
    injectInlineNotif: (notifType, msg, opts) => echoes.push({ notifType, msg, opts }),
    updateCharCount: () => {},
    hideInputBar: () => {},
    updateInputPlaceholder: () => {},
    renderFeed: () => {},
    isOpMsg: () => false,
    buildFeedEmoteRefs: () => null,
    t: (k) => k,
    cleanup: { setTimeout: () => {} },
    showToast: () => {},
  }
  const names = Object.keys(stubs)
  const factory = new Function(...names, `${fnSrc}\nreturn postFeedMessage`)
  return { postFeedMessage: factory(...names.map((n) => stubs[n])), calls, echoes }
}

describe('postFeedMessage — topLevel gate (the /op-in-thread-view regression)', () => {
  test('topLevel: true with an active thread posts TOP-LEVEL (no reply_to)', async () => {
    const { postFeedMessage, calls } = harness({ activeThread: { id: 'abc', replies: [] } })
    await postFeedMessage('hello', { topLevel: true })
    expect(calls.length).toBe(1)
    expect(calls[0].body.reply_to).toBeUndefined()
  })

  test('default (contextual) with an active thread posts a reply', async () => {
    const { postFeedMessage, calls } = harness({ activeThread: { id: 'abc', replies: [] } })
    await postFeedMessage('hello')
    expect(calls[0].body.reply_to).toBe('abc')
  })

  test('default with no thread posts top-level', async () => {
    const { postFeedMessage, calls } = harness()
    await postFeedMessage('hello')
    expect(calls[0].body.reply_to).toBeUndefined()
  })
})

describe('caller contracts (input.js source)', () => {
  test('/op passes topLevel: true', () => {
    const opBlock = sliceBetween(INPUT_SRC, "if (cmd === 'op') {", "if (cmd === 'w') {")
    expect(opBlock).toContain('postFeedMessage(rest.trim(), { topLevel: true })')
  })

  test('feed-tab plain send is contextual (no forced topLevel)', () => {
    const feedBlock = sliceBetween(
      INPUT_SRC,
      '// Feed tab: plain text + media paste posts directly to home feed.',
      '// Whispers/mentions',
    )
    expect(feedBlock).toContain('postFeedMessage(text)')
    expect(feedBlock).not.toContain('topLevel: true')
  })
})

// /op posted fine but chat never showed it. The websocket new-message echo
// can't do the job: postFeedMessage optimistically unshifts the post into
// feedMessages, so the ws handler's "already in feed" dedup returns before it
// reaches injectInlineNotif (and it bails outright when the feed tab was never
// opened). The post must therefore echo itself.
describe('own post echoes into chat', () => {
  test('posting while on a chat tab injects the inline row', async () => {
    const { postFeedMessage, echoes } = harness({
      currentTab: 'kripp',
      posted: { base36_id: '00002p', created_at: '2026-07-30T19:00:00Z' },
    })
    await postFeedMessage('hello', { topLevel: true })
    expect(echoes.length).toBe(1)
    expect(echoes[0].msg.base36_id).toBe('00002p')
  })

  test('the echo bypasses the inline-notif toggle — it is your own receipt', async () => {
    const { postFeedMessage, echoes } = harness({
      currentTab: 'kripp',
      posted: { base36_id: '00002p', created_at: '2026-07-30T19:00:00Z' },
    })
    await postFeedMessage('hello', { topLevel: true })
    expect(echoes[0].opts?.force).toBe(true)
  })

  test('a server row with no created_at still echoes', async () => {
    const { postFeedMessage, echoes } = harness({
      currentTab: 'kripp',
      posted: { base36_id: '00002p' },
    })
    await postFeedMessage('hello', { topLevel: true })
    expect(echoes.length).toBe(1)
    expect(echoes[0].msg.created_at).toBeTruthy()
  })

  test('no echo on the feed tab — the post is already visible there', async () => {
    const { postFeedMessage, echoes } = harness({
      currentTab: 'feed',
      posted: { base36_id: '00002p', created_at: '2026-07-30T19:00:00Z' },
    })
    await postFeedMessage('hello', { topLevel: true })
    expect(echoes.length).toBe(0)
  })
})

describe('replyTo — /opr targets the last [OP] seen in chat', () => {
  test('replyTo wins over the open thread', async () => {
    const { postFeedMessage, calls } = harness({ activeThread: { id: 'openthread', replies: [] } })
    await postFeedMessage('nice one', { replyTo: '00002p' })
    expect(calls[0].body.reply_to).toBe('00002p')
  })

  test('without replyTo the open thread still wins (unchanged)', async () => {
    const { postFeedMessage, calls } = harness({ activeThread: { id: 'openthread', replies: [] } })
    await postFeedMessage('nice one')
    expect(calls[0].body.reply_to).toBe('openthread')
  })
})
