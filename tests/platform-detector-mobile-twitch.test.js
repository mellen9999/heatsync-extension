/**
 * F-ext-2 — m.twitch.tv matches the manifest's https://*.twitch.tv/* wildcard
 * but serves a genuinely separate mobile DOM none of our selectors match.
 * manifest.exclude_matches (src/manifests/{chrome,firefox}.json) is the real
 * fix — it stops every content script from injecting there at all. This pins
 * detectPlatform()'s own contract stays honest as a second line of defense.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SRC = readFileSync(join(ROOT, 'chrome', 'platform-detector.js'), 'utf8')

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  const end = src.indexOf('\n  }', start)
  return src.slice(start, end + 4)
}

function detectPlatformFor(hostname) {
  const fn = new Function('window', `${extractFn(SRC, 'detectPlatform')}\nreturn detectPlatform()`)
  return fn({ location: { hostname } })
}

describe('detectPlatform', () => {
  test('m.twitch.tv is not detected as twitch (separate mobile DOM)', () => {
    expect(detectPlatformFor('m.twitch.tv')).toBeNull()
  })

  test('desktop www.twitch.tv is still twitch', () => {
    expect(detectPlatformFor('www.twitch.tv')).toBe('twitch')
  })

  test('bare twitch.tv is still twitch', () => {
    expect(detectPlatformFor('twitch.tv')).toBe('twitch')
  })

  test('kick.com unaffected', () => {
    expect(detectPlatformFor('kick.com')).toBe('kick')
  })

  test('youtube.com unaffected', () => {
    expect(detectPlatformFor('www.youtube.com')).toBe('youtube')
  })

  test('unrelated host is null', () => {
    expect(detectPlatformFor('example.com')).toBeNull()
  })
})

describe('manifest exclude_matches (belt-and-suspenders on top of the detector)', () => {
  test('every content_scripts entry matching *.twitch.tv/* excludes m.twitch.tv, both browsers', () => {
    for (const browser of ['chrome', 'firefox']) {
      const manifest = JSON.parse(readFileSync(join(ROOT, 'src', 'manifests', `${browser}.json`), 'utf8'))
      for (const entry of manifest.content_scripts) {
        if (!entry.matches?.includes('https://*.twitch.tv/*')) continue
        expect(entry.exclude_matches, `${browser}: ${JSON.stringify(entry.js)}`).toContain('https://m.twitch.tv/*')
      }
    }
  })
})
