/**
 * Twitch killed chat commands over IRC in Feb 2023. /ban /timeout /unban
 * /delete got real GQL handlers, and /vip /unvip joined them 2026-07-22
 * (VIPUser/UnVIPUser, op shapes captured live). /clear /color /mod /unmod /raid
 * /unraid /commercial /marker still have none — and with no handler they fell
 * through to a plain send, putting the broadcaster's own moderation command
 * on the wire as message text.
 *
 * Two things must stay true: they are refused before that send, and they are
 * never advertised as working commands again.
 *
 * Carves the registries out of input.js (non-module bundle), same approach as
 * slash-alias-complete.test.js.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SLASH_REGISTRY } from '../src/multichat/slash-registry.js'

const ROOT = join(import.meta.dir, '..')
const SRC = readFileSync(join(ROOT, 'src', 'multichat', 'input.js'), 'utf8')

function slice(start, end) {
  const s = SRC.indexOf(start)
  const e = SRC.indexOf(end, s)
  if (s === -1 || e === -1) throw new Error(`markers not found: ${start} .. ${end}`)
  return SRC.slice(s, e)
}

const deadSrc = slice('const DEAD_TWITCH_CHAT_COMMANDS = new Set([', '\nconst NON_ECHOING_CHAT_COMMANDS')
// The dead set still lives in input.js beside the guard it feeds, so it stays
// carved. The command list comes from the registry — and the check now covers
// hidden rows too, which a slice of the advertised array could not.
const SLASH_COMMANDS = SLASH_REGISTRY
const { DEAD_TWITCH_CHAT_COMMANDS } = new Function(`${deadSrc}\nreturn { DEAD_TWITCH_CHAT_COMMANDS }`)()

describe('dead twitch chat commands', () => {
  test('the whole deprecated set is covered', () => {
    for (const cmd of ['clear', 'color', 'raid', 'unraid', 'commercial', 'marker']) {
      expect(DEAD_TWITCH_CHAT_COMMANDS.has(cmd)).toBe(true)
    }
    // vip/unvip/mod/unmod are NOT dead anymore — implemented via GQL 2026-07-22.
    for (const cmd of ['vip', 'unvip', 'mod', 'unmod']) {
      expect(DEAD_TWITCH_CHAT_COMMANDS.has(cmd)).toBe(false)
    }
  })

  test('none of them is advertised in the command list', () => {
    const advertised = SLASH_COMMANDS.map((c) => c.cmd).filter((c) => DEAD_TWITCH_CHAT_COMMANDS.has(c))
    expect(advertised).toEqual([])
  })

  test('commands that DO work are still advertised', () => {
    const names = SLASH_COMMANDS.map((c) => c.cmd)
    for (const cmd of [
      'ban',
      'timeout',
      'unban',
      'delete',
      'announce',
      'slow',
      'followers',
      'vip',
      'unvip',
      'mod',
      'unmod',
    ]) {
      expect(names).toContain(cmd)
    }
  })

  test('handleSlashCommand refuses them instead of falling through to a send', () => {
    const guard = SRC.indexOf('DEAD_TWITCH_CHAT_COMMANDS.has(cmd)')
    const fallthrough = SRC.indexOf('\n  return false\n}', SRC.indexOf('async function handleSlashCommand'))
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(fallthrough)
  })

  test('the refusal string exists, so the toast never renders a raw key', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'src', '_locales', 'en', 'messages.json'), 'utf8'))
    expect(en.mc_input_cmd_twitch_removed?.message).toContain('$CMD$')
  })
})
