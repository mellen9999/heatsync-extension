/**
 * The filled/docked video player is a child of the chat scroller but not a
 * row. The render reconciler's PASS A sweeps every child that is not a kept
 * message — it killed the player on the next full render (popout: the player
 * opened and vanished in ~100ms). The walk must also step over its slot.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main.js'), 'utf8')
const passA = SRC.slice(SRC.indexOf('// PASS A: index existing DOM'), SRC.indexOf('// PASS B: walk desired list'))

describe('render reconcile and the video player', () => {
  test('PASS A leaves #hs-mc-embed-player alone', () => {
    expect(passA).toMatch(/c\.id === 'hs-mc-embed-player'[\s\S]{0,40}i\+\+[\s\S]{0,20}continue/)
  })
  test('PASS B steps over the player slot and the hard cap counts it', () => {
    expect(SRC).toMatch(/after\?\.id === 'hs-mc-embed-player'\) after = after\.nextElementSibling/)
    expect(SRC).toMatch(/hardCap =[\s\S]{0,160}#hs-mc-embed-player/)
  })
})
