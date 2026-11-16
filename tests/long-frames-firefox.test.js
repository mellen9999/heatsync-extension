/**
 * The long-frame watchdog observes 'long-animation-frame', which only chromium has: firefox
 * logged "Ignoring unsupported entryTypes" on every page (s9, 11-16). Runs the real
 * watchLongFrames from src/multichat/main-messages.js against both browsers' observers.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'main-messages.js'), 'utf8')
const s = SRC.indexOf('function watchLongFrames(')
const BODY = SRC.slice(s, SRC.indexOf('\n}\n', s) + 3)

function run(supported) {
  const observed = []
  class PO {
    static supportedEntryTypes = supported
    observe(o) {
      observed.push(o.type)
    }
  }
  new Function('globalThis', 'PerformanceObserver', `${BODY}\nwatchLongFrames()`)({ PerformanceObserver: PO }, PO)
  return observed
}

test('chromium: long frames are watched', () => {
  expect(run(['longtask', 'long-animation-frame'])).toEqual(['long-animation-frame'])
})

test('firefox: no observer asked for a type it does not have', () => {
  expect(run(['longtask', 'paint'])).toEqual([])
})
