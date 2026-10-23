import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ← back closes the NEWEST surface. A card opened over a playing video used to
 * lose to the filled player: back un-filled the video behind it and the card
 * stayed on screen (popout, 2026-10-23).
 */

const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'pane-panel.js'), 'utf8')
const body = src.slice(src.indexOf('function hsTakeoverCloser() {'), src.indexOf('function hsTakeoverSync()'))

// Run the real function with the surfaces that are "open" stubbed in.
function closerFor(open) {
  const calls = []
  const env = {
    hsPanePanelOpen: () => !!open.panel,
    activePanePanel: { finish: () => calls.push('panel') },
    activeProfileCard: open.card ? { floating: false } : null,
    closeProfileCard: () => calls.push('card'),
    activeChatLogs: open.logs ? {} : null,
    closeChatLogsView: () => calls.push('logs'),
    predViewOpen: () => !!open.pred,
    closePredView: () => calls.push('pred'),
    _hsAudio: open.fill ? { fill: true } : null,
    _hsSetFill: () => calls.push('fill'),
  }
  const fn = new Function(...Object.keys(env), `${body}; return hsTakeoverCloser()`)
  const close = fn(...Object.values(env))
  close?.()
  return calls
}

describe('hsTakeoverCloser order', () => {
  test('a card over a filled video closes the card, not the video', () => {
    expect(closerFor({ card: true, fill: true })).toEqual(['card'])
  })
  test('logs over a filled video closes the logs', () => {
    expect(closerFor({ logs: true, fill: true })).toEqual(['logs'])
  })
  test('the filled video is what back closes once nothing sits over it', () => {
    expect(closerFor({ fill: true })).toEqual(['fill'])
  })
  test('nothing open: nothing to close', () => {
    expect(closerFor({})).toEqual([])
  })
})
