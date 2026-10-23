import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'emotes.js'), 'utf8')

describe('emote picker search', () => {
  test('7tv results use webp, like every other 7tv url (avif is slow to decode, missing for old emotes)', () => {
    const fn = src.slice(src.indexOf('async function mcSearch7tvApi'), src.indexOf('async function mcSearchFfzApi'))
    expect(fn).toContain('/1x.webp')
    expect(fn).not.toContain('/1x.avif')
  })

  test('load more keeps paging when a page adds no new name — one tile per name made it look dead', () => {
    expect(src).toContain('mcProviderEmptyRun')
    expect(src).toContain('MC_EMPTY_PAGES_MAX')
    expect(src).toMatch(/if \(!newNames && page > 1 && !mcProviderExhausted\[p\]\)/)
  })
})
