// /highlight spends REAL bits. Twitch's transactionID is the bits idempotency
// key — the old code minted a fresh one per attempt, so a client-side timeout
// that reported "failed" invited a resend Twitch charged a second time. These
// prove the transaction is reused across a resend (no double-charge) and
// released on confirmed success (a later deliberate resend charges fresh).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const API = readFileSync(join(ROOT, 'src', 'multichat', 'twitch-api.js'), 'utf8')
const INPUT = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')
const EN = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

// Rebuild the transaction cache + its accessor against a deterministic clock
// and uuid source, so we can assert reuse-vs-fresh without touching the network.
function makeTxns() {
  let now = 1_000_000
  return new Function(
    'clock',
    'uuid',
    `const Date = { now: () => clock.now }
     const crypto = { randomUUID: () => 'uuid-' + uuid.n++ }
     ${API.slice(API.indexOf('const _highlightTxns ='), API.indexOf('async function sendHighlightedTwitchMessage'))}
     return { _highlightTxnFor, _highlightTxns, tick: (ms) => { clock.now += ms } }`,
  )({ now }, { n: 0 })
}

describe('highlight transaction idempotency', () => {
  test('a resend of the same message reuses nonce AND transactionID', () => {
    const m = makeTxns()
    const a = m._highlightTxnFor('123', 'gg wp', null)
    const b = m._highlightTxnFor('123', 'gg wp', null)
    expect(b.transactionID).toBe(a.transactionID)
    expect(b.nonce).toBe(a.nonce)
  })

  test('a different message gets its own transaction', () => {
    const m = makeTxns()
    const a = m._highlightTxnFor('123', 'gg wp', null)
    const b = m._highlightTxnFor('123', 'different', null)
    expect(b.transactionID).not.toBe(a.transactionID)
  })

  test('a different channel gets its own transaction', () => {
    const m = makeTxns()
    const a = m._highlightTxnFor('123', 'gg wp', null)
    const b = m._highlightTxnFor('456', 'gg wp', null)
    expect(b.transactionID).not.toBe(a.transactionID)
  })

  test('reply parent is part of the identity', () => {
    const m = makeTxns()
    const a = m._highlightTxnFor('123', 'gg wp', null)
    const b = m._highlightTxnFor('123', 'gg wp', 'parent-msg-id')
    expect(b.transactionID).not.toBe(a.transactionID)
  })

  test('once released, the same text starts a fresh transaction', () => {
    const m = makeTxns()
    const a = m._highlightTxnFor('123', 'gg wp', null)
    m._highlightTxns.delete(a.key)
    const b = m._highlightTxnFor('123', 'gg wp', null)
    expect(b.transactionID).not.toBe(a.transactionID)
  })

  test('after the TTL a stale transaction is not reused (safety cutoff)', () => {
    const m = makeTxns()
    const a = m._highlightTxnFor('123', 'gg wp', null)
    m.tick(5 * 60 * 1000 + 1)
    const b = m._highlightTxnFor('123', 'gg wp', null)
    expect(b.transactionID).not.toBe(a.transactionID)
  })
})

describe('send result contract', () => {
  const fn = extractFn(API, 'sendHighlightedTwitchMessage')
  test('a throw returns unconfirmed, never a plain error', () => {
    expect(fn).toContain('unconfirmed: true')
  })
  test('the transaction is dropped only on a structured response', () => {
    // delete lives in the try (confirmed), not the catch (unconfirmed).
    const tryBlock = fn.slice(fn.indexOf('try {'), fn.indexOf('} catch'))
    expect(tryBlock).toContain('_highlightTxns.delete(txn.key)')
    const catchBlock = fn.slice(fn.indexOf('} catch'))
    expect(catchBlock).not.toContain('_highlightTxns.delete')
  })
})

describe('composer honesty', () => {
  test('unconfirmed is handled distinctly from failure and does not clear input', () => {
    const branch = INPUT.slice(
      INPUT.indexOf('} else if (r?.unconfirmed) {'),
      INPUT.indexOf('mc_input_highlight_failed'),
    )
    expect(branch).toContain('mc_input_highlight_unconfirmed')
    expect(branch).not.toContain('clearInput')
  })
  test('the unconfirmed copy exists and does not read as a failure', () => {
    expect(EN.mc_input_highlight_unconfirmed?.message).toBeTruthy()
    expect(EN.mc_input_highlight_unconfirmed.message.toLowerCase()).not.toContain('failed')
  })
})
