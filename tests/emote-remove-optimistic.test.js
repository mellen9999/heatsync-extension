/**
 * Removing an emote from your set flips the UI before the server answers.
 * The DELETE takes seconds; the row and the open hover tooltip must change the
 * instant you right-click, and a failed DELETE must put everything back.
 * Pinned at source level, like the other multichat wiring tests.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const start = SRC.indexOf('async function _removeEmoteFromInventory(')
const FN = SRC.slice(start, SRC.indexOf('// Re-run the hover', start))

describe('remove from set is optimistic', () => {
  test('local state changes before the server round trip', () => {
    expect(FN.indexOf('applyLocalRemoval(')).toBeGreaterThan(-1)
    expect(FN.indexOf('applyLocalRemoval(')).toBeLessThan(FN.indexOf("type: 'remove_from_inventory'"))
  })

  test('a failed or errored remove rolls back', () => {
    expect(FN.match(/undo\(pt\)/g)?.length).toBe(2)
  })

  test('the toast waits for the server', () => {
    expect(FN.indexOf("t('mc_emote_removed'")).toBeGreaterThan(FN.indexOf("type: 'remove_from_inventory'"))
  })

  test('the open tooltip is re-run on both paths', () => {
    expect(SRC).toContain('rehoverAt(pt, false)')
    expect(SRC).toContain('rehoverAt(undoPt, true)')
  })
})

describe('a poll that raced the delete cannot put the emote back', () => {
  const MAIN = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
  const inv = MAIN.slice(MAIN.indexOf("msg.type === 'inventory_update'"))

  test('removal stamps the name, rollback and re-add clear it', () => {
    expect(SRC).toContain('localRemovals.set(emoteName, Date.now())')
    expect(SRC.match(/localRemovals\.delete\(emoteName\)/g)?.length).toBe(2)
  })

  test('inventory_update skips a name removed moments ago', () => {
    expect(inv.indexOf('isLocallyRemoved(e.name)')).toBeGreaterThan(-1)
    expect(inv.indexOf('isLocallyRemoved(e.name)')).toBeLessThan(inv.indexOf('inventoryEmotes.add(e.name)'))
  })
})
