/**
 * Command receipts persist into buffers at their send timestamp and survive
 * a tab switch — and the ✓/✗ settle has to reach EVERY live copy of the row,
 * not just whichever tab happens to be on screen.
 *
 * Two scopes (mellen's ruling): account-level commands (/follow, /mute, /set,
 * …) persist into every channel's buffer, like injectInlineNotif already does
 * for real notifications. Channel-bound commands (/ban, /timeout, /poll, …)
 * persist ONLY into the buffer of the channel they were sent from — a /ban
 * shown in another channel's tab would read as a ban there.
 *
 * Harness: eval the shipped injectInlineNotif/beginCmdReceipt/settleCmdReceipt
 * with stubbed globals, same technique as tests/whisper-own-send-echo.test.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const start = SRC.indexOf('  function injectInlineNotif(notifType, msg, opts = {}) {')
const end = SRC.indexOf('\n  // Font family + size')
const fnSrc = SRC.slice(start, end)

function harness({ currentTab = 'chanA' } = {}) {
  const els = []
  const document = {
    querySelectorAll: (sel) => {
      const id = sel.match(/data-send-id="([^"]+)"/)?.[1]
      return els.filter((e) => e.dataset.sendId === id)
    },
  }
  // A fake DOM row, registered whenever the render half would have appended
  // one — mirrors appendMessage's real contract (only called for the
  // currently-visible tab).
  function makeEl(sendId) {
    const mark = { textContent: '', className: '' }
    const el = { dataset: { sendId }, failed: false, classList: { toggle: (_c, on) => (el.failed = !!on) }, mark }
    el.querySelector = (s) => (s === '.hs-cmd-mark' ? mark : null)
    els.push(el)
    return el
  }
  const appended = []
  function makeBuffer() {
    const items = []
    items.push = Array.prototype.push.bind(items)
    return items
  }
  const ircBufs = new Map()
  const kickBufs = new Map()
  const ytBufs = new Map()
  const config = {
    channels: [
      { id: 'chanA', twitch: 'chanA' },
      { id: 'chanB', twitch: 'chanB' },
    ],
  }
  for (const ch of config.channels) {
    ircBufs.set(ch.twitch, makeBuffer())
    ytBufs.set(ch.id, makeBuffer())
  }
  const stubs = {
    inlineNotifs: {},
    INLINE_NOTIF_TYPES: { cmd: { tag: '[cmd]', color: '#808080', borderColor: '#808080' } },
    config,
    irc: { channels: ircBufs },
    kickChat: { channels: kickBufs },
    channelYtMessages: ytBufs,
    PERSIST_MAX_YT: 500,
    currentTab,
    getChannelById: (id) => config.channels.find((c) => c.id === id) || null,
    getLiveChannel: () => null,
    appendMessage: (msg, tabId) => {
      appended.push(tabId)
      makeEl(msg.sendId)
      return true
    },
    document,
  }
  const names = Object.keys(stubs)
  const { injectInlineNotif, beginCmdReceipt, settleCmdReceipt } = new Function(
    ...names,
    `${fnSrc}\nreturn { injectInlineNotif, beginCmdReceipt, settleCmdReceipt }`,
  )(...names.map((n) => stubs[n]))
  return { injectInlineNotif, beginCmdReceipt, settleCmdReceipt, ircBufs, ytBufs, appended, els }
}

describe('global-scope receipt (account-level command)', () => {
  test('persists into every channel buffer, like a real inline notif', () => {
    const h = harness({ currentTab: 'chanA' })
    const receipt = h.beginCmdReceipt('/mute someone')
    expect(h.ircBufs.get('chanA')).toContain(receipt)
    expect(h.ircBufs.get('chanB')).toContain(receipt)
    expect(h.appended).toEqual(['chanA']) // live-appended only to the visible tab
  })

  test('settling reaches every copy of the row, not just the visible one', () => {
    const h = harness({ currentTab: 'chanA' })
    const receipt = h.beginCmdReceipt('/mute someone')
    // A second live copy of the same receipt (e.g. a popout), simulating
    // "every tab holding it" beyond the one appendMessage actually rendered.
    const extra = { dataset: { sendId: receipt.sendId }, mark: { textContent: '', className: '' } }
    extra.classList = { toggle: (_c, on) => (extra.failed = !!on) }
    extra.querySelector = () => extra.mark
    h.els.push(extra)

    h.settleCmdReceipt(receipt, false, 'not a moderator')

    for (const el of h.els) {
      expect(el.mark.textContent).toBe('✗ not a moderator')
      expect(el.mark.className).toBe('hs-cmd-mark hs-cmd-fail')
      expect(el.failed).toBe(true)
    }
    expect(receipt.status).toBe('failed')
    expect(receipt.reason).toBe('not a moderator')
  })
})

describe('channel-scope receipt (mod/broadcaster command)', () => {
  test('persists ONLY into the channel it was sent from', () => {
    const h = harness({ currentTab: 'chanA' })
    const receipt = h.beginCmdReceipt('/ban xqc 10m', 'chanA')
    expect(h.ircBufs.get('chanA')).toContain(receipt)
    expect(h.ircBufs.get('chanB')).not.toContain(receipt)
    expect(h.appended).toEqual(['chanA'])
  })

  test('does not live-append into a different tab than it was sent from', () => {
    // Sent from chanA, but the panel has since switched to chanB before the
    // handler settles — must not paint a /ban into chanB's tab.
    const h = harness({ currentTab: 'chanB' })
    h.beginCmdReceipt('/ban xqc 10m', 'chanA')
    expect(h.appended).toEqual([])
    expect(h.ircBufs.get('chanA').length).toBe(1)
    expect(h.ircBufs.get('chanB').length).toBe(0)
  })

  test('a successful settle marks the ok state on every copy', () => {
    const h = harness({ currentTab: 'chanA' })
    const receipt = h.beginCmdReceipt('/timeout xqc 60', 'chanA')
    h.settleCmdReceipt(receipt, true)
    expect(h.els[0].mark.textContent).toBe('✓')
    expect(h.els[0].mark.className).toBe('hs-cmd-mark hs-cmd-ok')
    expect(h.els[0].failed).toBe(false)
    expect(receipt.status).toBe('ok')
  })
})
