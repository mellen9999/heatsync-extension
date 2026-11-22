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
  const world = { known: new Map(), remote: new Map() }
  const factory = new Function(
    'registerRemoteEmoteRef',
    'buildEmoteRefs',
    'recentRemoteCompletions',
    'lookupEmoteRenderOrder',
    `${SRC.slice(start, end)}\nreturn buildFeedEmoteRefs`,
  )
  const build = factory(
    refs.registerRemoteEmoteRef,
    refs.buildEmoteRefs,
    world.remote,
    (n) => world.known.get(n) || null,
  )
  return { build, world }
}

const X = 'https://cdn.7tv.app/emote/01XXXXXXXXXXXXXXXXXXXXXXXX/2x.webp'
const Y = 'https://cdn.7tv.app/emote/01YYYYYYYYYYYYYYYYYYYYYYYY/2x.webp'

describe('a feed post vouches only its own emotes', () => {
  test('a name an earlier post resolved does not vouch a later post that cannot resolve it', () => {
    const { build, world } = harness()
    world.known.set('KEKW', { url: X, source: '7tv' })
    expect(build('KEKW').KEKW.url).toBe(X)
    world.known.delete('KEKW')
    expect(build('KEKW hello')).toBeNull()
  })

  test("a search pick from an earlier post is not the name's meaning once the pick is gone", () => {
    const { build, world } = harness()
    world.remote.set('Pog', { url: Y, source: 'ffz' })
    expect(build('Pog').Pog.url).toBe(Y)
    world.remote.delete('Pog')
    world.known.set('Pog', { url: X, source: '7tv' })
    expect(build('Pog').Pog.url).toBe(X)
  })

  test('nothing a post registers is left in the shared list', () => {
    const { build, world } = harness()
    world.known.set('KEKW', { url: X, source: '7tv' })
    build('KEKW')
    expect(refs.lookupRemoteEmoteRef('KEKW')).toBeUndefined()
  })

  test('an owned emote keeps its hash; an overlay ships under the name without the 0', () => {
    const { build, world } = harness()
    world.known.set('mine', { url: X, source: 'inventory', hash: 'a'.repeat(64) })
    world.known.set('Rain', { url: Y, source: '7tv', zeroWidth: true })
    const out = build('mine Rain0')
    expect(out.mine.hash).toBe('a'.repeat(64))
    expect(out.Rain.url).toBe(Y)
  })
})
