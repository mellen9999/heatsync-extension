/**
 * A feed post vouches the emotes in ITS text and nothing left over from an
 * earlier post. buildFeedEmoteRefs registers what each word resolves to and
 * reads it straight back; the registrations used to sit in one shared list, so
 * a name an earlier post resolved (KEKW in the channel you were in then) still
 * vouched a later post whose KEKW resolved to nothing — a stale picture shipped.
 *
 * Harness: the real function source from social.js, run against the real
 * src/lib/emote-refs.js (the site's byte copy).
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as refs from '../src/lib/emote-refs.js'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'social.js'), 'utf8')
const start = SRC.indexOf('const FEED_REF_HASH_RE')
const end = SRC.indexOf('async function postFeedMessage', start)
if (start === -1 || end === -1) throw new Error('buildFeedEmoteRefs not found in social.js')

function harness() {
  // mine: your own set · globals · room: the open chat tab's emotes · box: the composer
  const world = { mine: new Map(), globals: new Map(), room: new Map(), box: {} }
  const factory = new Function(
    'registerRemoteEmoteRef',
    'buildEmoteRefs',
    'heldPick',
    'viewerPersonalEmotes',
    'emoteCache',
    'lookupPublicEmote',
    `${SRC.slice(start, end)}\nreturn buildFeedEmoteRefs`,
  )
  const build = factory(
    refs.registerRemoteEmoteRef,
    refs.buildEmoteRefs,
    refs.heldPick,
    world.mine,
    world.globals,
    (n) => world.room.get(n) || world.globals.get(n),
  )
  return { build, world }
}

const X = 'https://cdn.7tv.app/emote/01XXXXXXXXXXXXXXXXXXXXXXXX/2x.webp'
const Y = 'https://cdn.7tv.app/emote/01YYYYYYYYYYYYYYYYYYYYYYYY/2x.webp'

describe('a feed post vouches only its own emotes', () => {
  test('a name an earlier post resolved does not vouch a later post that cannot resolve it', () => {
    const { build, world } = harness()
    world.globals.set('KEKW', { url: X, source: '7tv' })
    expect(build('KEKW').KEKW.url).toBe(X)
    world.globals.delete('KEKW')
    expect(build('KEKW hello')).toBeNull()
  })

  test("a pick belongs to the post it was made in: the next post's same name is a hand-typed word", () => {
    const { build, world } = harness()
    refs.pinPickedEmote({ name: 'Pog', url: Y, provider: 'ffz' }, world.box)
    expect(build('Pog', world.box).Pog.url).toBe(Y)
    refs.endDraftPicks(world.box) // posted: the box is cleared, its picks with it
    world.globals.set('Pog', { url: X, source: '7tv' })
    expect(build('Pog', world.box).Pog.url).toBe(X)
  })

  test('a post has no room: the open chat tab does not answer for a word in it', () => {
    const { build, world } = harness()
    world.room.set('KEKW', { url: X, source: '7tv' })
    expect(build('KEKW', world.box)).toBeNull()
    world.mine.set('KEKW', { url: Y, source: '7tv' })
    expect(build('KEKW', world.box).KEKW.url).toBe(Y)
  })

  test("a chat line quoted into the feed is its room's words: the room's emote, never yours, never the composer's pick", () => {
    const { build, world } = harness()
    world.room.set('KEKW', { url: X, source: '7tv' })
    world.mine.set('KEKW', { url: Y, source: '7tv' })
    refs.pinPickedEmote({ name: 'KEKW', url: Y, provider: '7tv' }, world.box)
    expect(build('gg KEKW', null, true).KEKW.url).toBe(X)
    refs.endDraftPicks(world.box)
  })

  test('nothing a post registers is left in the shared list', () => {
    const { build, world } = harness()
    world.globals.set('KEKW', { url: X, source: '7tv' })
    build('KEKW')
    expect(refs.lookupRemoteEmoteRef('KEKW')).toBeUndefined()
  })

  test('an owned emote keeps its hash; an overlay ships under the name without the 0', () => {
    const { build, world } = harness()
    world.mine.set('mine', { url: X, source: 'inventory', hash: 'a'.repeat(64) })
    world.globals.set('Rain', { url: Y, source: '7tv', zeroWidth: true })
    const out = build('mine Rain0')
    expect(out.mine.hash).toBe('a'.repeat(64))
    expect(out.Rain.url).toBe(Y)
  })
})
