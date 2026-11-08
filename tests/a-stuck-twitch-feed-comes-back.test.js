/**
 * A stuck twitch feed comes back without a refresh.
 *
 * A viewer on nl_kripp saw the panel stop showing new lines until they
 * reloaded the page (2026-11-02). Two ways the background reader went quiet:
 *
 * - parked or dead with no retry armed: only a channel join reconnected it,
 *   and a tab joins once per channel, so its 15s interest ping kept the tab
 *   registered against a reader that would never come back;
 * - "RECONNECT" typed in chat (the whole room does when a stream drops) was
 *   taken for twitch's own reconnect command, tearing the reader down and
 *   dropping the rest of the frame; "Login authentication failed" in chat
 *   likewise flipped an authed reader to anonymous for 30 minutes.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bgSource } from './bg-src.js'

const BG_SRC = bgSource()

const fnStart = BG_SRC.indexOf('function bgIrcServerCommand(line)')
const fnEnd = BG_SRC.indexOf('\nfunction bgIrcConnect()', fnStart)
const bgIrcServerCommand = new Function(`${BG_SRC.slice(fnStart, fnEnd)}\nreturn bgIrcServerCommand`)()

describe('server commands are read from the command position', () => {
  test('twitch asking us to reconnect, with and without tags', () => {
    expect(bgIrcServerCommand(':tmi.twitch.tv RECONNECT')).toBe('RECONNECT')
    expect(bgIrcServerCommand('@badge-info= :tmi.twitch.tv RECONNECT')).toBe('RECONNECT')
    expect(bgIrcServerCommand(':tmi.twitch.tv NOTICE * :Login authentication failed')).toBe('NOTICE')
  })

  test('a chatter saying it is not a command', () => {
    const said = (text) =>
      `@badge-info=;color=#FF0000;display-name=viewer :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #nl_kripp :${text}`
    expect(bgIrcServerCommand(said('RECONNECT RECONNECT'))).toBe(null)
    expect(bgIrcServerCommand(said(':tmi.twitch.tv RECONNECT'))).toBe(null)
    expect(bgIrcServerCommand(said('Login authentication failed lol'))).toBe(null)
  })
})

describe('the reader loop uses it', () => {
  const loopStart = BG_SRC.indexOf('const cmd = bgIrcServerCommand(line)')
  const loop = BG_SRC.slice(loopStart, loopStart + 1200)

  test('reconnect and auth-failure branches gate on the command', () => {
    expect(loopStart).toBeGreaterThan(-1)
    expect(loop).toContain("cmd === 'RECONNECT'")
    expect(loop).toContain("cmd === 'NOTICE'")
    expect(loop).not.toContain("line.includes('RECONNECT')")
  })
})

describe('a tab still watching brings a parked reader back', () => {
  const start = BG_SRC.indexOf("if (message.type === 'bg_irc_interest') {")
  const end = BG_SRC.indexOf("if (message.type === 'bg_irc_part') {", start)
  const handler = BG_SRC.slice(start, end)

  test('the interest ping reconnects a reader with no socket and no retry armed', () => {
    expect(start).toBeGreaterThan(-1)
    expect(handler).toContain('!BG_IRC.ws && !BG_IRC.reconnectTimer) bgIrcConnect()')
  })
})
