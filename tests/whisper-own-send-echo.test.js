/**
 * Anything you send shows up inline as the confirmation.
 *
 * sendWhisperMessage echoed an outgoing whisper into the current chat tab
 * through injectInlineNotif('dm', …) with no force flag — and the inline-DM
 * toggle (which exists to silence OTHER people's whispers) is off by default,
 * so your own /w vanished from the tab you sent it from. A receipt for your
 * own action is forced, like the feed post receipt; a failed send marks it.
 *
 * Harness: eval the shipped sendWhisperMessage with stubbed globals.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'whispers.js'), 'utf8')
const start = SRC.indexOf('async function sendWhisperMessage(key, text) {')
const end = SRC.indexOf('\nfunction retryAuthFailedWhispers() {', start)
const fnSrc = SRC.slice(start, end)

function harness({ ok = true, currentTab = 'chan1' } = {}) {
  const injected = []
  const marked = []
  const stubs = {
    whisperUsers: new Map([
      ['twitch:rusticatedcharm', { platform: 'twitch', userId: '1', displayName: 'rusticatedcharm', color: '#fff' }],
    ]),
    whisperTimeline: [],
    trimWhisperTimeline: () => {},
    lastWhisperKey: null,
    currentTab,
    renderWhispersTab: () => {},
    injectInlineNotif: (type, msg, opts) => injected.push({ type, msg, opts }),
    whisperSaveDebounced: () => {},
    sendTwitchWhisper: async () => (ok ? { ok: true } : { ok: false, error: 'nope' }),
    apiFetch: async () => ({ ok }),
    showToast: () => {},
    t: (k) => k,
    document: { querySelectorAll: (sel) => [{ classList: { add: (c) => marked.push([sel, c]) } }] },
  }
  const names = Object.keys(stubs)
  const fn = new Function(...names, `${fnSrc}\nreturn sendWhisperMessage`)(...names.map((n) => stubs[n]))
  return { fn, injected, marked }
}

describe('own whisper echoes inline', () => {
  test('forced past the inline-DM toggle', async () => {
    const h = harness()
    expect(await h.fn('twitch:rusticatedcharm', 'hi')).toBe(true)
    expect(h.injected).toHaveLength(1)
    expect(h.injected[0].opts).toEqual({ force: true })
    expect(h.injected[0].msg.outgoing).toBe(true)
    expect(h.injected[0].msg.text).toBe('hi')
    expect(h.marked).toHaveLength(0)
  })

  test('a failed send marks the receipt instead of leaving it claiming success', async () => {
    const h = harness({ ok: false })
    expect(await h.fn('twitch:rusticatedcharm', 'hi')).toBe(false)
    expect(h.injected[0].msg.failed).toBe(true)
    expect(h.marked[0][1]).toBe('hs-whisper-failed')
    expect(h.marked[0][0]).toContain(h.injected[0].msg.sendId)
  })

  test('on the whispers tab it renders there, no inline copy', async () => {
    const h = harness({ currentTab: 'whispers' })
    await h.fn('twitch:rusticatedcharm', 'hi')
    expect(h.injected).toHaveLength(0)
  })
})
