/**
 * An older page of someone's logs failed (offline, a 429, a 500). The view redrew, the loader
 * was still in view, its observer fired at once and asked again, and again: a request loop
 * with no pause for as long as the api was down, and nothing on screen said the load had
 * failed unless the list was empty. The first page failing looped the same way.
 *
 * Runs the real clLoaderAsks against the observer's own entry shapes.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'multichat', 'chat-logs.js'), 'utf8')
const at = SRC.indexOf('function clLoaderAsks(entries, st) {')
const clLoaderAsks = new Function(`${SRC.slice(at, SRC.indexOf('\n}\n', at))}\n}\nreturn clLoaderAsks`)()
const seen = { isIntersecting: true }
const gone = { isIntersecting: false }

test('a loader that comes into view asks for the next page', () => {
  expect(clLoaderAsks([seen], { armed: true })).toBe(true)
  expect(clLoaderAsks([gone], { armed: true })).toBe(false)
})

test('after a failed page the loader in view does not ask again by itself', () => {
  const st = { armed: false }
  expect(clLoaderAsks([seen], st)).toBe(false) // the observer's first report: still in view
  expect(clLoaderAsks([seen], st)).toBe(false)
})

test('scrolled away and back, it asks: once it has left the view, the next sight of it counts', () => {
  const st = { armed: false }
  expect(clLoaderAsks([gone], st)).toBe(false)
  expect(clLoaderAsks([seen], st)).toBe(true)
  // both in one report (a fast flick): the order they happened in decides
  expect(clLoaderAsks([gone, seen], { armed: false })).toBe(true)
  expect(clLoaderAsks([seen, gone], { armed: false })).toBe(false)
})

test('the view arms the loader by whether the last page failed, says so, and a click tries again', () => {
  expect(SRC).toContain('const st = { armed: !failed }')
  expect(SRC).toContain('if (clLoaderAsks(entries, st)) more()')
  expect(SRC).toContain("if (failed && !loading) sentinel.addEventListener('click', more)")
  expect(SRC).toContain("const failedText = rows.length ? t('mc_logs_load_failed') : t('common_retry')")
  // the loader says it is loading as the request goes out, not only after a redraw
  const more = SRC.slice(
    SRC.indexOf('const more = () => {'),
    SRC.indexOf('fetchChatLogsPage()', SRC.indexOf('const more = () => {')),
  )
  expect(more).toContain("sentinel.textContent = t('content_card_loading')")
})
