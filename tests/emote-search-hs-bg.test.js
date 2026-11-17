import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The picker's heatsync search fetched heatsync.org from the page, which sends no
 * CORS allowance for twitch/kick/youtube: every search logged a refusal and the
 * heatsync results never came (s18 caught it live). It goes through the
 * background now, like every other heatsync.org call from a page.
 */
const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')
const s = SRC.indexOf('async function mcSearchHsApi(')
const FN = SRC.slice(s, SRC.indexOf('\n// Provider → page-fetcher', s))

const run = (apiFetch) => new Function('apiFetch', `${FN}\nreturn mcSearchHsApi`)(apiFetch)

test('results come back through the background proxy', async () => {
  let asked = null
  const search = run(async (path, opts) => {
    asked = { path, opts }
    return {
      ok: true,
      data: { results: { hs: [{ name: 'hsClap', url: 'https://cdn.heatsync.org/x.webp', id: '1' }] } },
    }
  })
  const out = await search('cl ap', new AbortController().signal)
  expect(asked).toEqual({ path: '/api/emote-search?q=cl%20ap&p=hs', opts: { auth: false } })
  expect(out).toEqual([{ name: 'hsClap', url: 'https://cdn.heatsync.org/x.webp', provider: 'heatsync', id: '1' }])
})

test('a refusal throws, an aborted search is an AbortError', async () => {
  await expect(run(async () => ({ ok: false, status: 500 }))('x', new AbortController().signal)).rejects.toThrow(
    'hs 500',
  )
  const ac = new AbortController()
  ac.abort()
  await expect(run(async () => ({ ok: true, data: { results: { hs: [] } } }))('x', ac.signal)).rejects.toThrow(
    'aborted',
  )
})

test('no page code fetches heatsync.org directly', () => {
  expect(FN).not.toContain('fetch(')
})
