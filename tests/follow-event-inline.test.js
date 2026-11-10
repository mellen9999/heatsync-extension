/**
 * A followed streamer going live / switching game has no tab of its own (that is
 * why it arrives as a follow event). It used to render only when the open tab
 * belonged to that streamer — never — so the desktop popup fired and chat showed
 * nothing. It now lands in the chat you are reading.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const at = SRC.indexOf("withGoLivePairing('follow_stream_event'")
const handler = SRC.slice(at, SRC.indexOf('// Handle color map from server', at))

describe('follow stream events render inline', () => {
  test('renders on the active tab without requiring it to be the streamer', () => {
    const tail = handler.slice(handler.indexOf('const activeTab = currentTab'))
    expect(tail).toContain('if (!appendMessage(evt, activeTab)) renderMessages(activeTab)')
    expect(tail).not.toContain('tw === channel')
    expect(tail).not.toContain('isLiveChannelMessage({ channel })) {')
  })

  test('a channel tab keeps the row in its own buffer so a repaint does not drop it', () => {
    const tail = handler.slice(handler.indexOf('const activeTab = currentTab'))
    expect(tail).toContain('buf.push(evt)')
    expect(tail).toContain("m.type === 'stream-event' && m.text === evt.text")
  })
})

// The server replays the day's follow history on every connect, a moment before
// it announces a fresh go-live. A replayed row carrying the same text (yesterday's
// "went live — World of Warcraft") must not mark that text seen, or today's line drops.
describe('follow history replay', () => {
  const at = SRC.indexOf('function processFollowHistory(')
  const body = SRC.slice(at, SRC.indexOf('function processFollowColors(', at))

  test('reads the realtime dedup but never writes it', () => {
    expect(body).toContain('streamEventDedup.has(text)')
    expect(body).not.toContain('streamEventDedup.set(')
  })
})
