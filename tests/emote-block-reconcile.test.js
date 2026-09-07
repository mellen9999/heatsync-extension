// Emote block/unblock used to show "blocked ✓" the instant you clicked, before
// the server answered — and the background reports an HTTP failure by RESOLVING
// {success:false}, which the old fire-and-forget `.catch()` never saw. A 500 /
// rate-limit / expired-token block looked successful, silently didn't persist,
// and reverted on the next inventory refetch with no signal. syncBlockToAPI now
// awaits the outcome, rolls the optimistic change back on a confirmed failure,
// and owns the toast. These prove the reconcile.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const EMOTES = readFileSync(join(ROOT, 'src', 'multichat', 'emotes.js'), 'utf8')

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end + 2)
}

// Run syncBlockToAPI against a scripted background response, capturing which
// reverse op ran and which toast fired.
function run({ block, resp, throws, silent }) {
  const calls = { toasts: [], rollback: null }
  const sendMessage = throws
    ? async () => {
        throw new Error('Extension context invalidated')
      }
    : async () => resp
  const harness = new Function(
    'sendMessage',
    'calls',
    `const browser = { runtime: { sendMessage } }
     const emoteHashes = new Map([['KEKW', 'abc']])
     const lookupEmote = () => null
     const log = () => {}
     const showToast = (msg, kind) => calls.toasts.push({ msg, kind })
     const t = (k) => k
     const blockEmote = (name, url, source, opts) => { calls.rollback = { op: 'block', name, opts } }
     const unblockEmote = (name, opts) => { calls.rollback = { op: 'unblock', name, opts } }
     return async ${extractFn(EMOTES, 'syncBlockToAPI')}`,
  )(sendMessage, calls)
  return harness('KEKW', block, { silent, url: 'https://x/e.png', source: 'kick' }).then(() => calls)
}

describe('block success path', () => {
  test('a confirmed block shows the success toast, no rollback', async () => {
    const c = await run({ block: true, resp: { success: true } })
    expect(c.rollback).toBeNull()
    expect(c.toasts).toEqual([{ msg: 'mc_emote_blocked_toast', kind: 'success' }])
  })

  test('logged-out local success still toasts', async () => {
    const c = await run({ block: true, resp: { success: true, local: true } })
    expect(c.toasts[0].kind).toBe('success')
  })
})

describe('block failure path', () => {
  test('a {success:false} block rolls back via unblock and shows the error', async () => {
    const c = await run({ block: true, resp: { success: false, error: 'HTTP 500' } })
    expect(c.rollback.op).toBe('unblock')
    expect(c.rollback.opts).toEqual({ skipSync: true, silent: true })
    expect(c.toasts).toEqual([{ msg: 'mc_emote_block_failed', kind: 'error' }])
  })

  test('a rejected sendMessage (context invalidated) also rolls back', async () => {
    const c = await run({ block: true, throws: true })
    expect(c.rollback.op).toBe('unblock')
    expect(c.toasts[0].msg).toBe('mc_emote_block_failed')
  })

  test('a failed UNBLOCK re-blocks (reverse direction)', async () => {
    const c = await run({ block: false, resp: { success: false, error: 'HTTP 429' } })
    expect(c.rollback.op).toBe('block')
    expect(c.toasts[0].msg).toBe('mc_emote_unblock_failed')
  })
})

describe('silent (rollback-of-rollback) never double-toasts', () => {
  test('a silent failure rolls back but shows no toast', async () => {
    const c = await run({ block: true, resp: { success: false, error: 'x' }, silent: true })
    expect(c.rollback).not.toBeNull()
    expect(c.toasts).toHaveLength(0)
  })
  test('a silent success shows no toast', async () => {
    const c = await run({ block: true, resp: { success: true }, silent: true })
    expect(c.toasts).toHaveLength(0)
  })
})

describe('optimistic UI wiring', () => {
  test('blockEmote no longer toasts inline except on skipSync', () => {
    const fn = extractFn(EMOTES, 'blockEmote')
    // the only success-toast in blockEmote is guarded by skipSync
    const toastLines = fn.split('\n').filter((l) => l.includes("mc_emote_blocked_toast'"))
    expect(toastLines.length).toBe(1)
    expect(toastLines[0]).toContain('skipSync')
  })
  test('syncBlockToAPI passes url+source so a re-block rollback can repaint', () => {
    expect(EMOTES).toContain('syncBlockToAPI(emoteName, false, { url: _bfEmote?.url')
  })
})
