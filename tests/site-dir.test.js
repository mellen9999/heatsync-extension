import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { siteDir, siteRequired } from './site-dir.js'

// the contract tests lean on this: a site that cannot be found must be loud where it is required, and
// a HS_SITE_DIR that points at the wrong place must never turn into a quiet skip

const made = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hs-site-dir-'))
  made.push(d)
  return d
}
const saved = process.env.HS_SITE_DIR
afterEach(() => {
  if (saved === undefined) delete process.env.HS_SITE_DIR
  else process.env.HS_SITE_DIR = saved
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('siteDir', () => {
  test('HS_SITE_DIR wins when it holds the probe', () => {
    const d = tmp()
    mkdirSync(join(d, 'client'), { recursive: true })
    writeFileSync(join(d, 'client', 'probe.js'), '')
    process.env.HS_SITE_DIR = d
    expect(siteDir('client/probe.js')).toBe(d)
  })

  test('HS_SITE_DIR pointing at something that is not the site is an error, not a skip', () => {
    process.env.HS_SITE_DIR = tmp()
    expect(() => siteDir('client/probe.js')).toThrow(/HS_SITE_DIR=.* has no client\/probe\.js/)
  })

  test('with nothing named, a probe no sibling has finds nothing', () => {
    delete process.env.HS_SITE_DIR
    expect(siteDir('definitely/not/in/any/repo.js')).toBeNull()
  })
})

describe('siteRequired', () => {
  test('ci requires the site', () => {
    expect(siteRequired({ CI: 'true' })).toBe(true)
  })
  test('a laptop with no CI var does not', () => {
    expect(siteRequired({})).toBe(false)
  })
  test('HS_REQUIRE_SITE=1 asks for it anywhere', () => {
    expect(siteRequired({ HS_REQUIRE_SITE: '1' })).toBe(true)
  })
  test('HS_PARITY_SKIP_OK=1 is the one explicit excuse', () => {
    expect(siteRequired({ CI: 'true', HS_PARITY_SKIP_OK: '1' })).toBe(false)
  })
})
