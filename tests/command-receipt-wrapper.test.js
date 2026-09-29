/**
 * Anything you send starting with / shows up inline as a confirmation.
 *
 * runSlashCommandWithReceipt wraps a slash-command handler's execution: for
 * anything scoped 'global' or 'channel' it opens a receipt row before
 * running the handler, then settles it ✓ or ✗ from whatever the
 * handler actually did — an 'error' toast fired mid-command (captured via
 * the _cmdReceiptStack frame this pushes, same object showToast writes
 * into), a thrown error, or an explicit `{ ok: false }` return. 'echo' and
 * 'none' scoped commands (already have their own echo, or are view-only)
 * get no receipt at all and just run.
 *
 * Harness: eval the shipped runSlashCommandWithReceipt with stubbed globals,
 * same technique as tests/whisper-own-send-echo.test.js.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const start = SRC.indexOf('async function runSlashCommandWithReceipt(text, execute) {')
const end = SRC.indexOf('\nfunction resolveSlashCmd', start)
const fnSrc = SRC.slice(start, SRC.lastIndexOf('\n}', end) + 2)

function harness({ scope = 'global', currentTab = 'chan1' } = {}) {
  const begun = []
  const settled = []
  const stack = []
  const stubs = {
    resolveSlashCmd: () => ({ cmd: 'x', rest: '' }),
    COMMAND_RECEIPT_SCOPE: { x: scope },
    currentTab,
    beginCmdReceipt: (text, onlyTab) => {
      const receipt = { text, onlyTab }
      begun.push(receipt)
      return receipt
    },
    settleCmdReceipt: (receipt, ok, reason) => settled.push({ receipt, ok, reason }),
    _cmdReceiptStack: stack,
  }
  const names = Object.keys(stubs)
  const fn = new Function(...names, `${fnSrc}\nreturn runSlashCommandWithReceipt`)(...names.map((n) => stubs[n]))
  return { fn, begun, settled, stack }
}

describe('runSlashCommandWithReceipt', () => {
  test('a side-effect command that succeeds gets a ✓ receipt', async () => {
    const h = harness()
    const result = await h.fn('/ban xqc 10m', async () => true)
    expect(result).toBe(true)
    expect(h.begun).toHaveLength(1)
    expect(h.begun[0]).toEqual({ text: '/ban xqc 10m', onlyTab: undefined })
    expect(h.settled).toHaveLength(1)
    expect(h.settled[0].ok).toBe(true)
    expect(h.stack).toHaveLength(0) // frame popped, no leak into the next command
  })

  test('channel scope opens the receipt onto the current tab', async () => {
    const h = harness({ scope: 'channel', currentTab: 'xqc' })
    await h.fn('/timeout xqc 60', async () => true)
    expect(h.begun[0].onlyTab).toBe('xqc')
  })

  test('an error toast fired mid-command marks the receipt ✗ with that reason', async () => {
    const h = harness()
    const result = await h.fn('/ban xqc', async () => {
      // Simulates showToast(msg, 'error') writing into the top capture frame
      // while the handler's own await chain is still in flight.
      h.stack[h.stack.length - 1].reason = 'not a moderator'
      return true
    })
    expect(result).toBe(true)
    expect(h.settled[0].ok).toBe(false)
    expect(h.settled[0].reason).toBe('not a moderator')
  })

  test('an explicit ok:false return marks the receipt failed too', async () => {
    const h = harness()
    await h.fn('/dm someone hi', async () => ({ ok: false, error: 'rate limited' }))
    expect(h.settled[0].ok).toBe(false)
    expect(h.settled[0].reason).toBe('rate limited')
  })

  test('a thrown error marks the receipt failed and still rethrows', async () => {
    const h = harness()
    await expect(
      h.fn('/ban xqc', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(h.settled[0].ok).toBe(false)
    expect(h.settled[0].reason).toBe('boom')
    expect(h.stack).toHaveLength(0)
  })

  test('a view-only or echo-scoped command gets no receipt at all', async () => {
    const h = harness({ scope: 'none' })
    const result = await h.fn('/help', async () => true)
    expect(result).toBe(true)
    expect(h.begun).toHaveLength(0)
    expect(h.settled).toHaveLength(0)
  })
})
