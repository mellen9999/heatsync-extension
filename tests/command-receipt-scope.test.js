/**
 * Classification completeness for slash-command receipts.
 *
 * "Anything I send should show up inline as a confirmation" is built ONCE,
 * centrally, in runSlashCommandWithReceipt (input.js) — every handler keeps
 * reporting failure exactly how it already does, and the wrapper derives a
 * receipt from that instead of ~50 handlers rolling their own. The one way
 * this drifts is a new /command landing in handleSlashCommand (or CHAT_MODES)
 * without anyone remembering to add it to COMMAND_RECEIPT_SCOPE — silently
 * defaulting to "no receipt" for a command that DOES have a side effect.
 *
 * This test extracts the real dispatch surface (every `cmd === '…'` branch
 * inside the shipped handleSlashCommand, plus CHAT_MODES' keys) and diffs it
 * against COMMAND_RECEIPT_SCOPE from the same file — in both directions, so
 * a stale entry for a removed command is caught too.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')

function extractObjectLiteral(varDecl) {
  const start = SRC.indexOf(varDecl)
  if (start === -1) throw new Error(`not found: ${varDecl}`)
  const end = SRC.indexOf('\n}', start) + 2
  const snippet = SRC.slice(start, end)
  const name = varDecl.match(/const (\w+)/)[1]
  return new Function(`${snippet}\nreturn ${name}`)()
}

const COMMAND_RECEIPT_SCOPE = extractObjectLiteral('const COMMAND_RECEIPT_SCOPE = {')
const CHAT_MODES = extractObjectLiteral('const CHAT_MODES = {')

function extractHandleSlashCommandBody() {
  const start = SRC.indexOf('async function handleSlashCommand(text, input) {')
  if (start === -1) throw new Error('handleSlashCommand not found')
  const end = SRC.indexOf('\n}', start) + 2
  return SRC.slice(start, end)
}

function discoveredCommands() {
  const body = extractHandleSlashCommandBody()
  const set = new Set([...body.matchAll(/cmd === '([a-zA-Z0-9]+)'/g)].map((m) => m[1]))
  for (const k of Object.keys(CHAT_MODES)) set.add(k)
  return set
}

describe('command receipt classification is complete', () => {
  test('the scan actually found commands (guards against a dead regex)', () => {
    expect(discoveredCommands().size).toBeGreaterThan(40)
  })

  test('every dispatched command is classified', () => {
    const discovered = discoveredCommands()
    const missing = [...discovered].filter((c) => !(c in COMMAND_RECEIPT_SCOPE))
    expect(missing).toEqual([])
  })

  test('nothing is classified that no longer exists', () => {
    const discovered = discoveredCommands()
    const stale = Object.keys(COMMAND_RECEIPT_SCOPE).filter((c) => !discovered.has(c))
    expect(stale).toEqual([])
  })

  test('every scope value is one of the four recognized buckets', () => {
    const valid = new Set(['echo', 'none', 'global', 'channel'])
    const bad = Object.entries(COMMAND_RECEIPT_SCOPE)
      .filter(([, v]) => !valid.has(v))
      .map(([k, v]) => `${k}: ${v}`)
    expect(bad).toEqual([])
  })

  test('/w /dm /r stay echo-scoped — they already have a richer inline echo', () => {
    expect(COMMAND_RECEIPT_SCOPE.w).toBe('echo')
    expect(COMMAND_RECEIPT_SCOPE.dm).toBe('echo')
    expect(COMMAND_RECEIPT_SCOPE.r).toBe('echo')
  })

  test('mod/broadcaster actions are channel-scoped, not broadcast to every tab', () => {
    for (const c of ['ban', 'timeout', 'unban', 'delete', 'nuke', 'vip', 'mod', 'poll', 'prediction', 'slow']) {
      expect(COMMAND_RECEIPT_SCOPE[c]).toBe('channel')
    }
  })

  test('account-level actions are global — every chat tab', () => {
    for (const c of ['follow', 'unfollow', 'mute', 'unmute', 'block', 'hide', 'unhide', 'note', 'delnote', 'set']) {
      expect(COMMAND_RECEIPT_SCOPE[c]).toBe('global')
    }
  })
})
