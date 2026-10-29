import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/multichat/main.js', import.meta.url), 'utf8')
const at = src.indexOf("withGoLivePairing('stream_event'")
const listener = src.slice(at, src.indexOf("withGoLivePairing('follow_stream_event'"))

describe('room stream events', () => {
  test('only the live channel and your own tabs get a line or a notification', () => {
    const gate = listener.indexOf('if (!isMine) return')
    expect(gate).toBeGreaterThan(0)
    expect(listener).toContain('isLiveChannelMessage({ channel })')
    expect(listener).toContain('config.channels.some(')
    // the gate runs before anything is shown or notified
    expect(gate).toBeLessThan(listener.indexOf('notifyStreamEvent('))
  })
})
