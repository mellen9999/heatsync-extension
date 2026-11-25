/**
 * publish.js, the hourly retry script and its systemd units name the same things in three files:
 * the code a store answers while it still reviews the last version, the summary line that says a
 * leg landed, and the timer publish.js arms. A rename in one file would leave the retry crying
 * failure every hour (the chrome-only run once read "firefox: not attempted" as its own failure).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EDGE_LOCKED } from '../scripts/lib/edge-addons.js'

const ROOT = join(import.meta.dir, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const PUBLISH = read('scripts/publish.js')
const RETRY = read('scripts/store-retry-publish.sh')
const SERVICE = read('scripts/systemd/heatsync-store-retry@.service')

const retryLocks = Object.fromEntries([...RETRY.matchAll(/^\s+(\w+)\) LOCKED='(\w+)'/gm)].map((m) => [m[1], m[2]]))
const summaryLabels = Object.fromEntries(
  [...PUBLISH.matchAll(/line\('(\w+ *)', results\.(\w+)\)/g)].map((m) => [m[2], m[1]]),
)

describe('store retry', () => {
  test('the retry waits on the codes publish.js arms it for', () => {
    expect(retryLocks).toEqual({ chrome: 'ITEM_NOT_UPDATABLE', edge: EDGE_LOCKED })
    expect(PUBLISH).toContain("STORE_LOCKED = { chrome: 'ITEM_NOT_UPDATABLE', edge: EDGE_LOCKED }")
  })

  test("the retry's success check matches the summary line publish.js prints", () => {
    for (const store of Object.keys(retryLocks)) {
      const line = `  ${summaryLabels[store]}: published — pending review (hours-to-days)`
      expect(new RegExp(`^  ${store} *: published`).test(line)).toBe(true)
      const same = `  ${summaryLabels[store]}: already holds this version — nothing new to submit`
      expect(new RegExp(`^  ${store} *: already holds this version`).test(same)).toBe(true)
    }
    expect(PUBLISH).toContain("if (r.status === 'published') return console.log(`  ${label}: published —")
    expect(PUBLISH).toContain("if (r.status === 'same') return console.log(`  ${label}: already holds this version")
  })

  test('publish.js arms the timer the units define, and the service runs the script that exists', () => {
    expect(PUBLISH).toContain('const timer = `heatsync-store-retry@${store}.timer`')
    expect(RETRY).toContain('TIMER="heatsync-store-retry@$STORE.timer"')
    expect(SERVICE).toContain('ExecStart=%h/projects/heatsync-extension/scripts/store-retry-publish.sh %i')
    expect(statSync(join(ROOT, 'scripts/store-retry-publish.sh')).mode & 0o111).toBeTruthy()
  })
})
