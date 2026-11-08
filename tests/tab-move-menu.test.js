/**
 * A tab's right-click menu can move it: "move left" / "move right" ("up" / "down"
 * when the strip is a column), and there is ONE reorder, moveChannelOrder, which
 * tab mode's J/K calls too. Before this a mouse user had no way to reorder tabs
 * at all.
 *
 * moveChannelOrder + channelMoveOptions are sliced out of channel-mgmt.js and run
 * against a fake channel list, so the order really changes.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from './en-t.js'

const dir = join(import.meta.dir, '..', 'src', 'multichat')
const MGMT = readFileSync(join(dir, 'channel-mgmt.js'), 'utf8')
const SLICE = MGMT.slice(MGMT.indexOf('function moveChannelOrder('), MGMT.indexOf('function removeChannel('))

let config
let saves
let repaints
let api

beforeEach(() => {
  config = { channels: ['a', 'b', 'c', 'd'].map((id) => ({ id })) }
  saves = 0
  repaints = 0
  // `config` is the bundle's live binding: read through a getter on each call
  api = new Function(
    'getConfig',
    't',
    'saveConfig',
    'updateTabBar',
    `const config = { get channels() { return getConfig().channels } }
     ${SLICE}
     return { moveChannelOrder, channelMoveOptions }`,
  )(
    () => config,
    t,
    () => saves++,
    () => repaints++,
  )
})

const ids = () => config.channels.map((c) => c.id).join('')
const labels = (id, layout) => api.channelMoveOptions(id, layout).map((o) => o.label)

describe('which moves are offered', () => {
  test('a middle tab can go either way', () => {
    expect(labels('b')).toEqual(['move left', 'move right'])
  })

  test('the first tab cannot go left, the last cannot go right', () => {
    expect(labels('a')).toEqual(['move right'])
    expect(labels('d')).toEqual(['move left'])
  })

  test('a lone tab has nothing to offer; an unknown tab neither', () => {
    config.channels = [{ id: 'solo' }]
    expect(labels('solo')).toEqual([])
    expect(labels('ghost')).toEqual([])
  })

  test('a column of tabs (docked left or right) says up and down', () => {
    expect(labels('b', { vertical: true })).toEqual(['move up', 'move down'])
  })

  test('a right-to-left strip runs the other way: earlier is to the RIGHT', () => {
    const rtl = api.channelMoveOptions('b', { rtl: true })
    expect(rtl).toEqual([
      { label: 'move right', delta: -1 },
      { label: 'move left', delta: 1 },
    ])
  })

  test('the deltas are what moveChannelOrder takes: -1 earlier, +1 later', () => {
    expect(api.channelMoveOptions('b').map((o) => o.delta)).toEqual([-1, 1])
  })

  test('no config yet: nothing offered, nothing thrown', () => {
    config = {}
    expect(api.channelMoveOptions('a')).toEqual([])
  })
})

describe('picking one really moves the tab, through the one reorder', () => {
  const pick = (id, label, layout) => {
    const o = api.channelMoveOptions(id, layout).find((x) => x.label === label)
    return api.moveChannelOrder(id, o.delta)
  }

  test('move right, then left, in a horizontal strip', () => {
    expect(pick('b', 'move right')).toBe(true)
    expect(ids()).toBe('acbd')
    expect(pick('b', 'move left')).toBe(true)
    expect(ids()).toBe('abcd')
  })

  test('move down / up in a column does the same reorder', () => {
    expect(pick('a', 'move down', { vertical: true })).toBe(true)
    expect(ids()).toBe('bacd')
    expect(pick('a', 'move up', { vertical: true })).toBe(true)
    expect(ids()).toBe('abcd')
  })

  test('in a right-to-left strip "move left" is one place LATER in the list', () => {
    expect(pick('b', 'move left', { rtl: true })).toBe(true)
    expect(ids()).toBe('acbd')
  })

  test('it saves and repaints the strip', () => {
    pick('b', 'move right')
    expect(saves).toBe(1)
    expect(repaints).toBe(1)
  })

  test('walking a tab across the whole list stops at the end, never wraps', () => {
    for (let i = 0; i < 6; i++) api.moveChannelOrder('a', 1)
    expect(ids()).toBe('bcda')
    expect(api.moveChannelOrder('a', 1)).toBe(false)
    expect(labels('a')).toEqual(['move left'])
  })

  test('a refused move saves nothing', () => {
    expect(api.moveChannelOrder('a', -1)).toBe(false)
    expect(api.moveChannelOrder('ghost', 1)).toBe(false)
    expect(saves).toBe(0)
    expect(repaints).toBe(0)
  })
})

describe('one implementation, two entry points', () => {
  test('tab mode (J/K) and the menu both call moveChannelOrder; nobody reorders by hand', () => {
    expect(readFileSync(join(dir, 'tab-mode.js'), 'utf8')).toContain('moveChannelOrder(id, delta)')
    expect(readFileSync(join(dir, 'main-overlay.js'), 'utf8')).toContain('moveChannelOrder(tabId, mv.delta)')
    // the only place a channel is spliced to a new slot is moveChannelOrder itself
    expect(MGMT.match(/list\.splice\(to, 0/g)?.length).toBe(1)
  })
})
