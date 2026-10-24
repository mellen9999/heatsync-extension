/**
 * chat-docked-bottom callouts (resub share…) anchor above the input bar. With
 * the input bar hidden the geometry returned null, the layer stayed unplaced,
 * and the resub bar drew across the whole window instead of the chat column.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'notifs.js'), 'utf8')
const dock = SRC.slice(
  SRC.indexOf("registerLayer('chat-docked-bottom'"),
  SRC.indexOf("registerLayer('chat-docked-top'"),
)

describe('chat-docked-bottom geometry', () => {
  test('falls back to the overlay bottom when the input bar is hidden', () => {
    expect(dock).toMatch(/bottomY === null && ovRect && ovRect\.height > 0\) bottomY = ovRect\.bottom/)
  })
})
