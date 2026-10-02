/**
 * A command receipt is only ✓ when the thing happened.
 *
 * runSlashCommandWithReceipt settles ✓ unless the handler fired an 'error'
 * toast, threw, or returned { ok: false }. So every path in
 * handleSlashCommand that does NOTHING has to say so in one of those three
 * ways — a usage hint on a plain toast, an unawaited request, a cancelled
 * confirm or a logged-out gate that `return true`d all read as "[cmd] /op ✓"
 * for a command that never ran (audit 2026-09-30).
 *
 * Source-level, like command-receipt-scope.test.js: the handler is one
 * 1,300-line function over a hundred globals, so the contract is asserted on
 * the shipped text rather than by driving it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const hStart = SRC.indexOf('async function handleSlashCommand(text, input) {')
const hEnd = SRC.indexOf('\n// Resolve a username → whisper key', hStart)
const HANDLER = SRC.slice(hStart, hEnd)

/** every showToast(...) call in the handler, with its full argument text */
function toasts(src) {
  const out = []
  for (const m of src.matchAll(/showToast\(/g)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < src.length && depth; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
    }
    out.push(src.slice(m.index, i))
  }
  return out
}

describe('a no-op path never settles ✓', () => {
  test('every usage hint is an error toast, so the receipt reads ✗ usage', () => {
    const plain = toasts(HANDLER).filter((call) => /mc_input_usage_|usage: \//.test(call) && !/'error'/.test(call))
    expect(plain).toEqual([])
  })

  test('already-following / not-following / already-muted / not-muted are refusals', () => {
    const plain = toasts(HANDLER).filter(
      (call) =>
        /mc_input_already_following|mc_input_not_following|mc_input_already_muted|mc_input_not_muted/.test(call) &&
        !/'error'/.test(call),
    )
    expect(plain).toEqual([])
  })

  test('/follow waits for the request before the receipt can settle', () => {
    expect(HANDLER).toMatch(/await pcToggleFollow\(id, u, yf\)/)
    expect(HANDLER).not.toMatch(/\n\s*pcToggleFollow\(/)
  })

  test('a cancelled ban or nuke confirm returns a failure, not true', () => {
    expect(HANDLER).toMatch(/if \(r\?\.cancelled\) return _cancelled\(\)/)
    expect(HANDLER).toMatch(/if \(!ok\) return _cancelled\(\)\n\s*const results = await Promise\.allSettled/)
    expect(HANDLER).toMatch(/const _cancelled = \(\) => \(\{ ok: false, error: 'cancelled' \}\)/)
  })

  test('a logged-out twitch gate returns a failure with the reason, on every mod path', () => {
    const gates = HANDLER.match(/await _twitchModAuthOk\(\)\)\) return [^\n]+/g) || []
    expect(gates.length).toBeGreaterThanOrEqual(4)
    for (const g of gates) expect(g).toMatch(/return _notLoggedIn\(\)$/)
    expect(HANDLER).toMatch(/const _notLoggedIn = \(\) => \(\{ ok: false, error: t\('mc_input_not_logged_in'\)/)
  })

  test('the receipt wrapper marks an { ok: false } result with its reason', () => {
    const start = SRC.indexOf('async function runSlashCommandWithReceipt(text, execute) {')
    const end = SRC.indexOf('\nfunction resolveSlashCmd', start)
    const fn = SRC.slice(start, end)
    expect(fn).toMatch(/result\.ok === false/)
    expect(fn).toMatch(/result\.error/)
  })
})

describe('the send path after a slash command', () => {
  const sStart = SRC.indexOf('result = await runSlashCommandWithReceipt(text, () => handleSlashCommand(text, input))')
  const sEnd = SRC.indexOf('const sendToKick =', sStart)
  const SEND = SRC.slice(sStart, sEnd)

  test('an object result is consumed — a cancelled /ban never goes out as chat text', () => {
    expect(SEND).toMatch(/if \(result === true \|\| \(result && typeof result === 'object'\)\) return/)
  })

  test('an unknown /command is refused with a ✗ row before any platform leg, on every platform', () => {
    // the refusal sits between the dispatch and the first send-leg decision
    expect(SEND).toMatch(/settleCmdReceipt\(beginCmdReceipt\(text\), false, reason\)/)
    expect(SEND).toMatch(/\/\^\\\/\[a-zA-Z\]\/\.test\(text\) && !\/\^\\\/me\\b\/i\.test\(text\)/)
    // and the old twitch-only pass-through is gone: no send leg reads an orphan flag
    expect(SRC).not.toMatch(/orphanSlash/)
  })
})
