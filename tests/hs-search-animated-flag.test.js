/**
 * The heatsync emote search says `animated: false` for every upload — animated
 * webp included (a server bug, fixed on the server side). The extension must not
 * let that flag decide anything about a heatsync emote, or an animated upload
 * would be frozen (or a still would be sent through an animation path).
 *
 * Two places could have trusted it, and both are pinned here with the shipped
 * code:
 *   1. the search mapping (mcSearchHsApi) — it must not carry the flag forward;
 *   2. the static-frame derivation — for a heatsync url the answer must be the
 *      same whatever the flag says, so the file (not the flag) decides.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
function carve(startAnchor) {
  const a = SRC.indexOf(startAnchor)
  if (a === -1) throw new Error(`carve: ${startAnchor} not found — emotes.js moved`)
  return SRC.slice(a, SRC.indexOf('\n}', a) + 2)
}

const searchHs = (fetchImpl) =>
  new Function('fetch', `${carve('async function mcSearchHsApi(')}\nreturn mcSearchHsApi`)(fetchImpl)
const deriveStatic = new Function(`${carve('function deriveStaticEmoteSrc(')}\nreturn deriveStaticEmoteSrc`)()

const reply = (hs) => async () => ({ ok: true, status: 200, json: async () => ({ results: { hs } }) })
const CDN = 'https://cdn.heatsync.org/uploads'

describe('heatsync search results', () => {
  test('the server flag is not carried into the entry, whichever way it says', async () => {
    const out = await searchHs(
      reply([
        { name: 'Dance', url: `${CDN}/aaa.webp`, id: 'a', animated: false },
        { name: 'Still', url: `${CDN}/bbb.webp`, id: 'b', animated: true },
        { name: 'Bare', url: `${CDN}/ccc.webp`, id: 'c' },
      ]),
    )('dance')
    expect(out.map((e) => e.name)).toEqual(['Dance', 'Still', 'Bare'])
    for (const e of out) expect('animated' in e).toBe(false)
  })

  test('the rest of the entry is what the picker needs', async () => {
    const [e] = await searchHs(reply([{ name: 'Dance', url: `${CDN}/aaa.webp`, id: 'a', animated: false }]))('dance')
    expect(e).toEqual({ name: 'Dance', url: `${CDN}/aaa.webp`, provider: 'heatsync', id: 'a' })
  })
})

describe('static frame of a heatsync webp does not depend on the flag', () => {
  const urls = [`${CDN}/aaa.webp`, `${CDN}/aaa-2x.webp`, 'https://heatsync.org/uploads/aaa.webp']

  test('animated true, false and unknown give the same still', () => {
    for (const u of urls) {
      const still = deriveStatic(u, true)
      expect(still).toContain('/api/emote-proxy?url=')
      expect(still).toContain('&static=1')
      expect(deriveStatic(u, false)).toBe(still)
      expect(deriveStatic(u, undefined)).toBe(still)
    }
  })

  test('it is the first frame of THIS file — the original url stays the animated one', () => {
    const u = `${CDN}/aaa.webp`
    expect(deriveStatic(u, false)).toContain(encodeURIComponent(u))
  })

  test('for contrast: a provider that does read the flag still does', () => {
    const stv = 'https://cdn.7tv.app/emote/x/1x.webp'
    expect(deriveStatic(stv, false)).toBe(stv)
    expect(deriveStatic(stv, true)).toContain('1x_static.webp')
  })
})
