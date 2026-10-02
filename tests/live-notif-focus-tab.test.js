/**
 * A went-live notification click lands on the streamer's page: the tab already
 * on that channel is focused, a new one opens only when none is. It used to
 * open a fresh tab on every click. Evaluates background.js's real functions.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BG = readFileSync(join(import.meta.dir, '..', 'chrome', 'background.js'), 'utf8')
const fn = (name) => {
  const start = BG.indexOf(`function ${name}(`)
  const head = BG.lastIndexOf('\n', start) + 1
  const end = BG.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error(`${name} not found`)
  return BG.slice(head, end + 2)
}
const SRC = ['channelPageUrl', 'channelPageKey', 'focusOrOpenTab'].map(fn).join('\n')

function load(openTabs) {
  const calls = []
  const browser = {
    tabs: {
      query: async () => openTabs,
      update: async (id, o) => calls.push(['update', id, o]),
      create: async (o) => calls.push(['create', o.url]),
    },
    windows: { update: async (id, o) => calls.push(['window', id, o]) },
  }
  const m = new Function('browser', `${SRC}; return { channelPageUrl, channelPageKey, focusOrOpenTab }`)(browser)
  return { ...m, calls }
}

describe('went-live click → their tab', () => {
  test('focuses the tab already on that channel, case-insensitive', async () => {
    const m = load([
      { id: 1, windowId: 9, url: 'https://www.twitch.tv/other' },
      { id: 2, windowId: 7, url: 'https://www.twitch.tv/Shroud?ref=x' },
    ])
    await m.focusOrOpenTab(m.channelPageUrl('twitch', 'shroud'))
    expect(m.calls).toEqual([
      ['update', 2, { active: true }],
      ['window', 7, { focused: true }],
    ])
  })

  test('a popout chat tab counts as their chat', async () => {
    const m = load([{ id: 3, windowId: 1, url: 'https://www.twitch.tv/popout/shroud/chat?popout=' }])
    await m.focusOrOpenTab(m.channelPageUrl('twitch', 'shroud'))
    expect(m.calls[0]).toEqual(['update', 3, { active: true }])
  })

  test('opens a new tab when none is on that channel', async () => {
    const m = load([{ id: 1, windowId: 1, url: 'https://kick.com/shroud' }])
    await m.focusOrOpenTab(m.channelPageUrl('twitch', 'shroud'))
    expect(m.calls).toEqual([['create', 'https://www.twitch.tv/shroud']])
  })

  test('kick + youtube keys', () => {
    const m = load([])
    expect(m.channelPageKey('https://kick.com/XQC/videos')).toBe('kick.com/xqc')
    expect(m.channelPageKey('https://www.youtube.com/@Handle/live')).toBe('youtube.com/@handle')
    expect(m.channelPageKey(m.channelPageUrl('youtube', 'UCabc'))).toBe('youtube.com/ucabc')
  })

  test('refuses anything that is not a plain handle', () => {
    const m = load([])
    expect(m.channelPageUrl('twitch', '../evil')).toBeNull()
    expect(m.channelPageUrl('twitch', 'a b')).toBeNull()
    expect(m.channelPageUrl('evil', 'x')).toBeNull()
  })
})
