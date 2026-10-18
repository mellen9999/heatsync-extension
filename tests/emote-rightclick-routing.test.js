/**
 * Emote right-click routing — plain right-click acts on what the emote is to
 * you: blocked → unblock, in your inventory → remove from the inventory,
 * anything else → block. The shift menu keeps all three (block included, for an
 * inventory emote you want to hide but keep).
 *
 * History: 2026-08-03 plain right-click became always-block (removal was a
 * silent server-side mutation). 2026-10-18 mellen reversed it for owned emotes:
 * an emote that says "inventory" must remove itself from the inventory, not
 * block. The handler is a document-level capture listener wired into the
 * bundle — pinned at source level like the other reader-loop wiring tests.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INPUT_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const SCHEMA_SRC = readFileSync(join(import.meta.dir, '..', 'src', 'lib', 'settings-schema.js'), 'utf8')
const EN_LOCALE = readFileSync(join(import.meta.dir, '..', 'src', '_locales', 'en', 'messages.json'), 'utf8')

// Carve the global contextmenu handler (plain right-click routing).
const handlerStart = INPUT_SRC.indexOf('// Global right-click handler for ALL emotes')
const handlerEnd = INPUT_SRC.indexOf('{ capture: true, signal: mcSignal }', handlerStart)
const HANDLER = INPUT_SRC.slice(handlerStart, handlerEnd)

// Carve the shift menu builder.
const menuStart = INPUT_SRC.indexOf('function openEmoteCtxMenu(')
const menuEnd = INPUT_SRC.indexOf('function openEmojiCtxMenu(', menuStart)
const MENU = INPUT_SRC.slice(menuStart, menuEnd)

describe('plain right-click: unblock / remove from inventory / block', () => {
  test('carve markers found', () => {
    expect(handlerStart).toBeGreaterThan(-1)
    expect(handlerEnd).toBeGreaterThan(handlerStart)
    expect(menuStart).toBeGreaterThan(-1)
    expect(menuEnd).toBeGreaterThan(menuStart)
  })

  test('blocked → unblock, inventory → remove, everything else → block', () => {
    expect(HANDLER).toContain("if (state === 'blocked')")
    expect(HANDLER).toContain('unblockEmote(emoteName)')
    expect(HANDLER).toContain("state === 'owned' && inventoryEmotes.has(emoteName)")
    expect(HANDLER).toContain('removeEmoteFromInventory(emoteName, e.target)')
    expect(HANDLER).toContain('blockEmote(emoteName, emoteUrl, source)')
  })

  test('the inventory branch comes before the block fallback', () => {
    expect(HANDLER.indexOf('removeEmoteFromInventory')).toBeLessThan(HANDLER.indexOf('blockEmote(emoteName, emoteUrl'))
  })

  test('load-bearing guards survived: stack expand, emoji menu, race guard, shift menu', () => {
    expect(HANDLER).toContain('.hs-mc-emote-stack:not(.expanded)')
    expect(HANDLER).toContain('openEmojiCtxMenu')
    expect(HANDLER).toContain('pendingEmoteOps.has(emoteName)')
    expect(HANDLER).toContain('openEmoteCtxMenu(e.clientX, e.clientY')
  })
})

describe('shift menu owns removal + block parity', () => {
  test('remove from set gated to genuine inventory emotes', () => {
    expect(MENU).toContain("state === 'owned' && inventoryEmotes.has(emoteName)")
    expect(MENU).toContain("label: 'remove from set'")
    expect(MENU).toContain('removeEmoteFromInventory(emoteName, targetEl)')
  })

  test('block/unblock reachable from the menu too', () => {
    expect(MENU).toContain("label: 'block'")
    expect(MENU).toContain("label: 'unblock'")
  })

  test('handler passes the clicked element through for picker-tile cleanup', () => {
    expect(HANDLER).toContain('targetEl: e.target')
  })
})

describe('dead right-click-block toggle fully removed', () => {
  test('gone from settings schema', () => {
    expect(SCHEMA_SRC).not.toContain('right-click-block')
  })
  test('gone from en locale', () => {
    expect(EN_LOCALE).not.toContain('sub_right_click_block')
  })
})
