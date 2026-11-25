/**
 * A collapsed-stack click pastes and registers for auto-add, exactly like a
 * single emote click: the set only changes when the message is SENT.
 * (src/multichat/input.js global click handler)
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'input.js'), 'utf8')
const a = SRC.indexOf('// Collapsed stack left-click')
const b = SRC.indexOf('const emoteInfo = findEmoteTarget(e.target)', a)
if (a === -1 || b === -1 || b <= a) throw new Error('stack handler carve markers not found')
const stack = SRC.slice(a, b)

test('a stack click never writes to the inventory on click', () => {
  expect(stack).not.toContain('addEmoteToInventory(')
})

test('every postable stack member (unadded too) registers for auto-add on send', () => {
  expect(stack).toContain('registerClickPasteForAutoAdd(')
  expect(stack).not.toMatch(/dataset\.state === 'unadded'\)\s*\{[^}]*addEmote/)
})
