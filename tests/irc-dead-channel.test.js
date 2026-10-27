/**
 * A channel twitch refuses ("does not exist or has been suspended") must not
 * loop. The refusal used to count as healthy traffic, so the 120s silence
 * watchdog PART+JOINed it, twitch refused again, and chat got the same notice
 * every ~140s forever (a youtube-only creator whose twitch was banned).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')
const handle = SRC.slice(SRC.indexOf('function bgIrcHandleLine(line) {'))
const watchdog = SRC.slice(SRC.indexOf('// Per-channel watchdog'), SRC.indexOf('// 20s interval (was 30s)'))

describe('refused twitch channel', () => {
  test('the refusal is not counted as traffic and is announced once', () => {
    const head = handle.slice(0, handle.indexOf("if (msg.type === 'roomstate')"))
    expect(head).toContain("msg.noticeType === 'msg_channel_suspended'")
    expect(head).toContain("msg.noticeType === 'msg_channel_blocked'")
    expect(head).toContain('chanLastSeen.delete(msg.channel)')
    expect(head).toContain('if (BG_IRC.deadChannels.has(msg.channel)) return')
    // traffic marking is the else branch, so a refusal never reaches it
    expect(head).toMatch(/\} else if \(msg\.channel\) \{\s*BG_IRC\.chanLastSeen\.set/)
  })

  test('the silence watchdog leaves a refused channel alone', () => {
    expect(watchdog).toContain('BG_IRC.deadChannels.has(ch)')
  })

  test('leaving the channel forgets the refusal, so a later re-add is tried again', () => {
    expect(SRC).toContain('BG_IRC.deadChannels.delete(ch)')
  })
})
